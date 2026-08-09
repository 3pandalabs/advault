"use client";

// Browser-side calls go to the public, Cloudflare-proxied hostname. The
// orange-to-orange restriction that forces server-side code onto
// INTERNAL_API_URL does not apply here — a real browser is not a same-account
// Worker.
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail?: string,
  ) {
    super(code);
  }
}

const ACCESS_KEY = "av_access_token";
const REFRESH_KEY = "av_refresh_token";

export function getTokens() {
  if (typeof window === "undefined") return { access: null, refresh: null };
  return {
    access: window.localStorage.getItem(ACCESS_KEY),
    refresh: window.localStorage.getItem(REFRESH_KEY),
  };
}

export function setTokens(access: string, refresh: string) {
  window.localStorage.setItem(ACCESS_KEY, access);
  window.localStorage.setItem(REFRESH_KEY, refresh);
}

export function clearTokens() {
  window.localStorage.removeItem(ACCESS_KEY);
  window.localStorage.removeItem(REFRESH_KEY);
}

async function refreshTokens(): Promise<string | null> {
  const { refresh } = getTokens();
  if (!refresh) return null;

  const res = await fetch(`${API_URL}/auth/refresh`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refreshToken: refresh }),
  });
  if (!res.ok) {
    clearTokens();
    return null;
  }
  const data = (await res.json()) as { accessToken: string; refreshToken: string };
  setTokens(data.accessToken, data.refreshToken);
  return data.accessToken;
}

// Access tokens live 15 minutes, so a 401 mid-session is expected, not
// exceptional. Retry once after refreshing; a second 401 means the refresh
// token is gone too and the caller should send the advertiser to /login.
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const send = (token: string | null) =>
    fetch(`${API_URL}${path}`, {
      ...init,
      headers: {
        // Only when there IS a body. Fastify rejects a request that declares
        // application/json and then sends nothing
        // (FST_ERR_CTP_EMPTY_JSON_BODY) before routing it, so a bodyless POST
        // — launch, retry, and any other action-shaped endpoint — would fail
        // with a generic error that looks like the route is missing.
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(init.headers ?? {}),
      },
    });

  let res = await send(getTokens().access);
  if (res.status === 401) {
    const fresh = await refreshTokens();
    if (fresh) res = await send(fresh);
  }

  if (!res.ok) {
    // The API answers with { error: "<code>" }; surface the code so callers can
    // map it to a specific message ("google_ads_not_configured" reads very
    // differently from a generic failure) without parsing prose.
    const body = (await res.json().catch(() => null)) as
      | { error?: string; detail?: string }
      | null;
    throw new ApiError(res.status, body?.error ?? "request_failed", body?.detail);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

// --- shared response types -------------------------------------------------

export type Me = {
  id: string;
  email: string;
  displayName: string | null;
  businessName: string | null;
  businessCategory: string | null;
  phone: string | null;
  role: "advertiser" | "admin";
};

export type Asset = {
  id: string;
  kind: "photo" | "logo";
  r2Key: string;
  contentType: string;
  originalFilename: string | null;
  createdAt: string;
};

export type CampaignStatus = "draft" | "rendering" | "ready" | "live" | "paused" | "failed";

export type Campaign = {
  spendMinorToDate: number;
  pausedForFundsAt: string | null;
  id: string;
  name: string;
  businessName: string;
  businessCategory: string;
  callToAction: string;
  landingUrl: string;
  offerDetails: string | null;
  targetZipCodes: string[];
  radiusMiles: number;
  dailyBudgetCents: number;
  currencyCode: string;
  status: CampaignStatus;
  googleCampaignResourceName: string | null;
  launchError: string | null;
  launchedAt: string | null;
  createdAt: string;
};

export type AdScript = {
  hook: string;
  scenes: { assetIndex: number; caption: string; durationSeconds: number }[];
  callToAction: string;
  endCardText: string;
  voiceoverText: string;
};

export type Creative = {
  id: string;
  campaignId: string;
  aspectRatio: "16:9" | "9:16";
  script: AdScript | null;
  scriptSource: "ai" | "fallback" | "manual" | null;
  renderStatus: "queued" | "rendering" | "ready" | "failed";
  renderError: string | null;
  videoKey: string | null;
  thumbnailKey: string | null;
  durationSeconds: number | null;
  createdAt: string;
};

// Who pays Google. 'platform' means AdVault's card is behind the account and
// the wallet is live; 'customer' means the advertiser's own card is, and the
// wallet is irrelevant to them. Getting this wrong on screen shows someone a
// balance that has nothing to do with their campaigns.
export type BillingMode = "platform" | "customer";

export type BillingLinkStatus = "pending" | "invited" | "active" | "failed" | null;

export type AdAccount = {
  isManaged: boolean;
  provisionStatus: string | null;
  provisionError: string | null;
  id: string;
  customerId: string;
  descriptiveName: string | null;
  currencyCode: string | null;
  isTestAccount: "yes" | "no" | "unknown";
  status: "active" | "revoked";
  connectedAt: string;
  billingMode: BillingMode;
  billingLinkStatus: BillingLinkStatus;
  billingConfirmedAt: string | null;
  // Where the advertiser enters a card. Only set for managed accounts they pay
  // for themselves — there is no API that adds a payment method, so this link
  // is the whole of that step.
  billingUrl: string | null;
};

export type BillingStatus = AdAccount & {
  billingConfigured: boolean;
  invitationState?: string;
  polling: boolean;
  billingDetail?: string;
};

export type BillingOptions = {
  modes: BillingMode[];
  /** True only when both modes are offered — otherwise there is nothing to ask. */
  prompt: boolean;
  mccConfigured: boolean;
};

// --- endpoint wrappers -----------------------------------------------------

export const getMe = () => api<Me>("/auth/me");
export const listCampaigns = () => api<Campaign[]>("/campaigns");
export const getCampaign = (id: string) =>
  api<Campaign & { creatives: Creative[] }>(`/campaigns/${id}`);
export const listAssets = () => api<Asset[]>("/assets");

export const listAdAccounts = () =>
  api<{ configured: boolean; accounts: AdAccount[] }>("/ad-accounts");

export function login(email: string, password: string) {
  return api<{ accessToken: string; refreshToken: string }>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}

export function register(input: {
  email: string;
  password: string;
  displayName?: string;
  businessName?: string;
  businessCategory?: string;
}) {
  return api<{ accessToken: string; refreshToken: string }>("/auth/register", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function createCampaign(input: {
  name: string;
  businessName: string;
  businessCategory: string;
  callToAction: string;
  landingUrl: string;
  offerDetails?: string | null;
  targetZipCodes: string[];
  radiusMiles: number;
  dailyBudgetCents: number;
}) {
  return api<Campaign>("/campaigns", { method: "POST", body: JSON.stringify(input) });
}

export function generateCreatives(
  campaignId: string,
  input: { assetIds: string[]; aspectRatios: ("16:9" | "9:16")[] },
) {
  return api<{ creatives: Creative[] }>(`/campaigns/${campaignId}/creatives/generate`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function launchCampaign(campaignId: string, adAccountId: string) {
  return api<{
    campaign: Campaign;
    zipCodesRequested: number;
    zipCodesTargeted: number;
    note: string;
  }>(`/campaigns/${campaignId}/launch`, {
    method: "POST",
    body: JSON.stringify({ adAccountId }),
  });
}

export const retryCreative = (creativeId: string) =>
  api<{ ok: true }>(`/creatives/${creativeId}/retry`, { method: "POST" });

export const creativeDownloadUrl = (key: string) =>
  api<{ url: string }>("/creatives/download-url", {
    method: "POST",
    body: JSON.stringify({ key }),
  });

export const assetDownloadUrl = (key: string) =>
  api<{ url: string }>("/assets/presign-download", {
    method: "POST",
    body: JSON.stringify({ key }),
  });

export const googleAuthorizeUrl = () =>
  api<{ url: string }>("/ad-accounts/google/authorize-url");

export const disconnectAdAccount = (id: string) =>
  api<void>(`/ad-accounts/${id}`, { method: "DELETE" });

// Two steps: ask the API for a presigned PUT, then upload straight to R2. The
// file never passes through the API, which is what keeps a 10MB storefront
// photo from occupying a Fastify worker for the length of a phone's upload.
export async function uploadAsset(file: File, kind: "photo" | "logo" = "photo"): Promise<Asset> {
  const { key, uploadUrl } = await api<{ key: string; uploadUrl: string }>(
    "/assets/presign-upload",
    { method: "POST", body: JSON.stringify({ contentType: file.type, kind }) },
  );

  const put = await fetch(uploadUrl, {
    method: "PUT",
    // Must match the content type pinned into the signature, or R2 rejects it.
    headers: { "content-type": file.type },
    body: file,
  });
  if (!put.ok) throw new ApiError(put.status, "upload_failed");

  return api<Asset>("/assets", {
    method: "POST",
    body: JSON.stringify({
      key,
      contentType: file.type,
      kind,
      sizeBytes: file.size,
      originalFilename: file.name,
    }),
  });
}

// --- billing ---------------------------------------------------------------

export type LedgerEntry = {
  id: string;
  type: "topup" | "spend" | "fee" | "refund" | "adjustment";
  amountMinor: number;
  currencyCode: string;
  description: string | null;
  campaignId: string | null;
  createdAt: string;
};

export type Wallet = {
  balanceMinor: number;
  currencyCode: "INR" | "USD";
  display: string;
  entries: LedgerEntry[];
};

export const getWallet = () => api<Wallet>("/wallet");

export function topUp(amountMinor: number) {
  return api<{
    paymentId: string;
    provider: "razorpay" | "stripe" | "manual";
    redirectUrl: string | null;
    clientPayload: Record<string, unknown>;
  }>("/wallet/topup", { method: "POST", body: JSON.stringify({ amountMinor }) });
}

// Creates the managed (MCC) child account.
//
// `billingMode` is required whenever the deployment offers both — the API
// refuses to guess, because defaulting would silently put an advertiser on
// AdVault's credit card. Call billingOptions() first.
export const provisionManagedAccount = (billingMode?: BillingMode) =>
  api<AdAccount & { invitationSent?: boolean; billingWarning?: string; billingDetail?: string }>(
    "/ad-accounts/managed",
    { method: "POST", body: JSON.stringify(billingMode ? { billingMode } : {}) },
  );

export const billingOptions = () => api<BillingOptions>("/ad-accounts/billing-options");

// Polled while the advertiser is off in Google accepting the invitation and
// entering a card. Stop when `polling` goes false.
export const adAccountBillingStatus = (id: string) =>
  api<BillingStatus>(`/ad-accounts/${id}/billing-status`);

export const resendBillingInvite = (id: string) =>
  api<AdAccount & { invitationSent: boolean }>(`/ad-accounts/${id}/billing/resend-invite`, {
    method: "POST",
  });

export const setBillingMode = (id: string, billingMode: BillingMode) =>
  api<AdAccount & { invitationSent?: boolean }>(`/ad-accounts/${id}/billing-mode`, {
    method: "POST",
    body: JSON.stringify({ billingMode }),
  });

export type PricingEstimate = {
  currency: "INR" | "USD";
  adBudgetMinor: number;
  /** The recurring platform fee. There is no one-off charge any more. */
  monthlyFeeMinor: number;
  monthlyTotalMinor: number;
  reach: { low: number; high: number };
  display: { adBudget: string; monthlyTotal: string };
};

export type Plan = {
  key: string;
  line: "offer" | "managed";
  label: string;
  blurb: string;
  currency: "INR" | "USD";
  monthlyFeeMinor: number;
  includedCreativesPerMonth: number;
  suggestedAdBudgetMinor: number;
  minDailyBudgetMinor: number;
  display: { monthlyFee: string; allIn: string };
  reach: { low: number; high: number } | null;
};

export function listPlans(currency: string) {
  return api<{ currency: string; plans: Plan[] }>(`/plans?currency=${encodeURIComponent(currency)}`);
}

export type SubscriptionView = {
  subscription: {
    id: string;
    planKey: string;
    line: "offer" | "managed";
    status: string;
    amountMinor: number;
    currencyCode: string;
    display: string;
    currentPeriodStart: string | null;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
    pastDue: boolean;
  } | null;
  entitled: boolean;
  invoices?: {
    id: string;
    amountMinor: number;
    currencyCode: string;
    periodStart: string;
    periodEnd: string;
    status: string;
    paidAt: string | null;
  }[];
};

export function getSubscription() {
  return api<SubscriptionView>("/subscription");
}

export function subscribe(planKey: string) {
  return api<{
    subscriptionId: string;
    invoiceId: string;
    provider: string;
    redirectUrl: string | null;
    clientPayload: Record<string, unknown>;
  }>("/subscription", { method: "POST", body: JSON.stringify({ planKey }) });
}

export function cancelSubscription(immediate = false) {
  return api<{ status: string; cancelAtPeriodEnd: boolean; servesUntil: string | null }>(
    "/subscription/cancel",
    { method: "POST", body: JSON.stringify({ immediate }) },
  );
}

export type OfferCycle = {
  id: string;
  periodMonth: string;
  status: "pending" | "prompted" | "answered" | "previewed" | "approved" | "skipped";
  offerText: string | null;
  offerExpiresAt: string | null;
};

export function currentOffer() {
  return api<{ cycle: OfferCycle | null; whatsappEnabled: boolean }>("/offers/current");
}

export function submitOffer(offerText: string, expiresAt?: string) {
  return api<{ cycleId: string; offerText: string; expiresAt: string; expiryInferred: boolean }>(
    "/offers/current",
    { method: "POST", body: JSON.stringify({ offerText, expiresAt }) },
  );
}

export function approveOffer(cycleId: string) {
  return api<{ status: string; expiresAt: string | null }>(`/offers/${cycleId}/approve`, {
    method: "POST",
  });
}

export function pricingEstimate(currency: string, adBudgetMinor: number, atCost = false) {
  const q = new URLSearchParams({
    currency,
    adBudgetMinor: String(adBudgetMinor),
    marginMode: atCost ? "at_cost" : "standard",
  });
  return api<PricingEstimate>(`/pricing/estimate?${q}`);
}

// --- Cinematic add-on -------------------------------------------------------
//
// A one-off purchase, not a subscription. `available` reflects whether the
// deployment has a text-to-video provider configured at all — the UI must
// respect it rather than letting someone pay for something that cannot be
// produced, because there is deliberately no cheaper fallback on this path.

export type AddOn = {
  key: string;
  sku: "cinematic";
  label: string;
  blurb: string;
  currency: "INR" | "USD";
  priceMinor: number;
  firstPurchasePriceMinor: number;
  generatedSeconds: number;
  totalSeconds: number;
  display: { price: string; firstPurchasePrice: string };
  available: boolean;
};

export function listAddOns(currency: string) {
  return api<AddOn[]>(`/add-ons?currency=${encodeURIComponent(currency)}`);
}

export type CinematicQuote = {
  addOnKey: string;
  currency: "INR" | "USD";
  amountMinor: number;
  listPriceMinor: number;
  isFirstPurchase: boolean;
  generatedSeconds: number;
  totalSeconds: number;
  available: boolean;
  display: { amount: string; listPrice: string };
};

export function cinematicQuote() {
  return api<CinematicQuote>("/cinematic/quote");
}

export type PurchaseStatus =
  | "pending"
  | "paid"
  | "producing"
  | "delivered"
  | "failed"
  | "refunded"
  | "cancelled";

export type CinematicOrder = {
  id: string;
  addOnKey: string;
  sku: string;
  campaignId: string | null;
  currency: "INR" | "USD";
  amountMinor: number;
  display: { amount: string };
  status: PurchaseStatus;
  attempts: number;
  // Surfaced deliberately. When someone has paid and has no ad, hiding the
  // reason from them is the wrong default.
  lastError: string | null;
  paidAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
};

export function listCinematicOrders() {
  return api<CinematicOrder[]>("/cinematic/orders");
}

export function getCinematicOrder(purchaseId: string) {
  return api<CinematicOrder>(`/cinematic/orders/${purchaseId}`);
}

export function orderCinematic(input: {
  campaignId: string;
  description: string;
  aspectRatio: "16:9" | "9:16";
}) {
  return api<{
    purchase: CinematicOrder;
    checkout: {
      provider: string;
      redirectUrl: string | null;
      clientPayload: Record<string, unknown>;
    };
  }>("/cinematic/orders", { method: "POST", body: JSON.stringify(input) });
}

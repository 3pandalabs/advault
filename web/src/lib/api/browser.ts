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

// Creates the managed (MCC) child account. The advertiser never sees Google.
export const provisionManagedAccount = () =>
  api<AdAccount>("/ad-accounts/managed", { method: "POST" });

export type PricingEstimate = {
  currency: "INR" | "USD";
  adBudgetMinor: number;
  creationFeeMinor: number;
  upfrontTotalMinor: number;
  reach: { low: number; high: number };
  display: { adBudget: string; upfrontTotal: string };
};

export function pricingEstimate(currency: string, adBudgetMinor: number, atCost = false) {
  const q = new URLSearchParams({
    currency,
    adBudgetMinor: String(adBudgetMinor),
    marginMode: atCost ? "at_cost" : "standard",
  });
  return api<PricingEstimate>(`/pricing/estimate?${q}`);
}

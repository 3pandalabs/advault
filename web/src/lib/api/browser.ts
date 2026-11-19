"use client";

import type { AudienceFilters, TargetAddress } from "@/lib/audience";

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
    readonly fields?: string[],
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
      | {
          error?: string;
          detail?: string;
          details?: { instancePath?: string; path?: (string | number)[] }[];
        }
      | null;
    // Validation failures carry `details`; reduce them to top-level field names
    // so the form can say WHICH field was rejected.
    const fields = (body?.details ?? [])
      .map((d) => (d.instancePath ? d.instancePath.split("/")[1] : String(d.path?.[0] ?? "")))
      .filter(Boolean);
    throw new ApiError(res.status, body?.error ?? "request_failed", body?.detail, fields);
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
  /**
   * Admin "Test as customer": billed like a customer, every charge $0.50.
   * Customer screens should use actsAsAdmin() (lib/testMode), never `role`.
   */
  testAsCustomer?: boolean;
  /** Shared 3PandaLabs account: the app the account was created on. */
  signupApp?: "advault" | "sitevault";
  /** The account has a SiteVault website. */
  usesSitevault?: boolean;
  /**
   * An admin's test customer (api routes/testCustomers.ts): always test mode,
   * $0.50 charges, launch is a dry run. The dashboard offers "Back to admin".
   */
  isTestCustomer?: boolean;
  /**
   * 3PandaLabs' own account (api migration 0032): a normal full-price
   * customer, kept out of revenue numbers. The header shows "Internal · <label>".
   */
  isInternal?: boolean;
  internalLabel?: string | null;
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

/** Real estate only: listing/open-house ad or agent ad (api lib/realty). */
export type Realty = {
  adType: "listing" | "agent";
  price?: string | null;
  beds?: number | null;
  baths?: number | null;
  openHouse?: { date: string; start: string; end: string } | null;
};

export type Campaign = {
  /** The ad account it was launched into; null until launch. */
  adAccountId: string | null;
  spendMinorToDate: number;
  pausedForFundsAt: string | null;
  id: string;
  name: string;
  businessName: string;
  businessCategory: string;
  callToAction: string;
  landingUrl: string | null;
  /** The ad video on the SiteVault site: asked for at launch (0026) / added. */
  siteVideoWanted?: boolean;
  siteVideoPushedAt?: string | null;
  /** Set when AdVault made the website with SiteVault (ciphertext; use getWebsite). */
  sitevaultEditEnc?: string | null;
  offerDetails: string | null;
  targetZipCodes: string[];
  radiusMiles: number;
  /** Real estate only: the listing a radius is drawn around (no ZIPs). */
  targetAddress: TargetAddress | null;
  /** null = everyone. */
  audienceFilters: AudienceFilters | null;
  dailyBudgetCents: number;
  currencyCode: string;
  /** 7 or 14 days; null = always on (migration 0033). */
  runDays?: number | null;
  /** Last serving day (YYYY-MM-DD), set at launch for a 1-/2-week run. */
  endsOn?: string | null;
  status: CampaignStatus;
  googleCampaignResourceName: string | null;
  launchError: string | null;
  launchedAt: string | null;
  createdAt: string;
  // Google's own review of the launched ad, copied hourly by the renderer.
  // Raw Google enums (ad_group_ad.policy_summary); null until first checked.
  googleAdApprovalStatus?: string | null;
  googleAdReviewStatus?: string | null;
  googleAdPolicyTopics?: string[];
  googleAdPolicyCheckedAt?: string | null;
};

export type VideoReviewStatus = "pending_review" | "approved" | "rejected";

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
  /** 1 = first make of the campaign's ad, +1 per redo. */
  version?: number;
  script: AdScript | null;
  scriptSource: "ai" | "fallback" | "manual" | null;
  renderStatus: "queued" | "rendering" | "ready" | "failed";
  renderError: string | null;
  videoKey: string | null;
  thumbnailKey: string | null;
  durationSeconds: number | null;
  createdAt: string;
  // 'upload' = a finished MP4 the advertiser (or an admin) uploaded; it has no
  // script and cannot be edited or re-rendered.
  kind: "standard" | "cinematic" | "upload";
  /** engine "reformat" = AdVault made this shape from the owner's other-shape video. */
  renderInfo?: { engine?: string } | null;
  googleAdResourceName: string | null;
  // AdVault's review of an uploaded video; null for everything AdVault made.
  reviewStatus: VideoReviewStatus | null;
  reviewReason: string | null;
  reviewedAt: string | null;

  // Whether this ad exists on YouTube yet, which is a harder requirement than
  // it sounds: a Google Ads video ad references a YouTube video id, never an
  // MP4 URL, so a creative with no id here cannot be attached to a campaign
  // and the campaign cannot serve. Shown separately from renderStatus for
  // exactly that reason — "your video is ready" and "your ad can run" are two
  // different statements.
  youtubeVideoId: string | null;
  youtubeUploadStatus: "pending" | "uploading" | "done" | "failed";
  youtubeUploadError: string | null;
  youtubeChannelSource: "org" | "advertiser" | null;
};

// Where this advertiser's ads get published. 'org' is the default and needs
// nothing from them; 'advertiser' means they connected their own channel.
export type YouTubeChannelStatus = {
  effectiveSource: "org" | "advertiser";
  ownChannel: {
    channelId: string;
    title: string | null;
    status: "active" | "revoked";
    connectedAt: string;
  } | null;
  canConnectOwnChannel: boolean;
  orgChannelConfigured: boolean;
  orgChannelTitle: string | null;
  // The honest answer to "can my ads actually run": false means uploads are
  // queueing up with nothing to drain them and no launch can succeed.
  uploadsPossible: boolean;
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
  // Null while 3PandaLabs is still creating the account in Google Ads.
  customerId: string | null;
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
/** Admins only (403 otherwise). */
export const setTestAsCustomer = (on: boolean) =>
  api<{ testAsCustomer: boolean }>("/auth/me/test-mode", { method: "PATCH", body: JSON.stringify({ on }) });
// --- admin test customers (api routes/testCustomers.ts) ----------------------

export type TestCustomer = { id: string; name: string; createdAt: string };

/** A real admin's test customers (also from inside one). 403 for everyone else. */
export const listTestCustomers = () =>
  api<{ customers: TestCustomer[]; current: string | null }>("/test-customers");

export const createTestCustomer = (name: string) =>
  api<TestCustomer>("/test-customers", { method: "POST", body: JSON.stringify({ name }) });

/** Swaps this browser's session to the other account; the old session is ended. */
async function swapSession(path: string) {
  const tokens = await api<{ accessToken: string; refreshToken: string }>(path, {
    method: "POST",
    body: JSON.stringify({ refreshToken: getTokens().refresh ?? undefined }),
  });
  setTokens(tokens.accessToken, tokens.refreshToken);
}

/** Become this test customer in this browser. */
export const switchToTestCustomer = (id: string) => swapSession(`/test-customers/${id}/switch`);

/** Leave the test customer and become the admin again. */
export const backToAdmin = () => swapSession("/test-customers/back");

export const listCampaigns = () => api<Campaign[]>("/campaigns");
export const getCampaign = (id: string) =>
  api<Campaign & { creatives: Creative[] }>(`/campaigns/${id}`);
export const listAssets = () => api<Asset[]>("/assets");

// Ad performance, read from the API's copy of Google's report (refreshed hourly
// by the renderer). Money is already formatted server-side in the campaign's
// currency; rates are 0..1.
export type MetricSummary = {
  impressions: number;
  views: number;
  clicks: number;
  spendMinor: number;
  spendDisplay: string;
  costPerViewMinor: number | null;
  costPerViewDisplay: string | null;
  ctr: number | null;
  viewRate: number | null;
};

export type CampaignMetrics = {
  campaignId: string;
  launched: boolean;
  days: number;
  since: string;
  currency: string;
  note: string;
  totals: MetricSummary | null;
  daily: (MetricSummary & { date: string })[];
  lastSyncedAt: string | null;
};

export type AdminMetrics = {
  days: number;
  since: string;
  note: string;
  totals: Record<string, MetricSummary>;
  campaigns: {
    campaignId: string;
    name: string;
    businessName: string;
    userEmail: string;
    status: string;
    currency: string;
    googleCustomerId: string | null;
    launchedAt: string | null;
    lastSyncedAt: string | null;
    totals: MetricSummary;
  }[];
};

// Admin only (the API enforces it).
export const getAdminMetrics = (days = 7) => api<AdminMetrics>(`/admin/metrics?days=${days}`);

export type BusinessSegment =
  | "regular" | "live" | "paused" | "lapsed" | "trying" | "new" | "stalled" | "never_started";
export type AdminBusiness = {
  generatedAt: string;
  /** fal credit, read hourly; null until the first reading (needs FAL_BILLING_KEY). */
  fal: {
    balance: number;
    checkedAt: string;
    level: "ok" | "low" | "critical";
    threshold: number;
    critical: number;
    burnPerDay: number | null;
    runwayDays: number | null;
  } | null;
  totals: { customers: number; signups7d: number; signups30d: number; liveNow: number; adsMade: number; totalViews: number };
  funnel: { step: string; count: number }[];
  segments: { key: BusinessSegment; label: string; hint: string; count: number }[];
  categories: { category: string; customers: number; campaigns: number; ads_made: number; launched: number; views: number }[];
  revenue: { source: string; currency: string; count: number; last30Display: string; allTimeDisplay: string }[];
  topAds: {
    campaignId: string; businessName: string; category: string; email: string; status: string;
    views: number; clicks: number; viewRate: number | null; costPerView: number | null;
  }[];
  customers: {
    id: string; email: string; businessName: string | null; category: string | null; createdAt: string;
    segment: BusinessSegment; photos: number; campaigns: number; adsMade: number; paidAds: number;
    launched: number; liveNow: number; views: number; revenueDisplay: string; lastActivityAt: string | null;
  }[];
  /** 3PandaLabs' own accounts (0032): paid full price, not in customers or revenue. */
  internal?: { id: string; email: string; label: string | null; paidMinor: number; paidDisplay: string; last30Display: string }[];
};
// Admin only (the API enforces it): customers, funnel, groups, categories.
export const getAdminBusiness = () => api<AdminBusiness>("/admin/business");

export const getCampaignMetrics = (id: string, days = 7) =>
  api<CampaignMetrics>(`/campaigns/${id}/metrics?days=${days}`);

// "How your ad is doing" (GET /campaigns/:id/results, 2026-11-19).
export type ResultsRange = "7d" | "30d" | "all";
export type ResultsBreakdownItem = {
  segment: string;
  label: string;
  share: number;
  impressions: number;
  views: number;
  clicks: number;
  spendMinor: number;
};
/** null = Google reported nothing for it yet (or withheld it): "Not enough views yet". */
export type ResultsBreakdown = ResultsBreakdownItem[] | null;
export type CampaignResults =
  | { campaignId: string; launched: false; range: ResultsRange }
  | {
      campaignId: string;
      launched: true;
      range: ResultsRange;
      since: string;
      currency: string;
      note: string;
      totals: {
        impressions: number;
        views: number;
        clicks: number;
        spendMinor: number;
        spendDisplay: string;
        costMicros: number;
        costPerViewMinor: number | null;
        costPerViewDisplay: string | null;
        costPerClickMinor: number | null;
        costPerClickDisplay: string | null;
      } | null;
      balance: { balanceMinor: number; display: string; daysLeft: number | null } | null;
      trend: { date: string; views: number; clicks: number; spendMinor: number; costPerViewMinor: number | null }[];
      breakdowns: {
        age: ResultsBreakdown;
        gender: ResultsBreakdown;
        device: ResultsBreakdown;
        network: ResultsBreakdown;
        location: ResultsBreakdown;
        hour: ResultsBreakdown;
        dayOfWeek: ResultsBreakdown;
      };
      lastSyncedAt: string | null;
    };
export const getCampaignResults = (id: string, range: ResultsRange = "7d") =>
  api<CampaignResults>(`/campaigns/${id}/results?range=${range}`);

export const listAdAccounts = () =>
  api<{ configured: boolean; managedOffered?: boolean; accounts: AdAccount[] }>("/ad-accounts");

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

// Password reset. request is enumeration-safe (always resolves); confirm throws
// ApiError("invalid_or_expired_token") on a bad or spent link.
export function requestPasswordReset(email: string) {
  return api<void>("/auth/password-reset/request", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

export function confirmPasswordReset(token: string, password: string) {
  return api<void>("/auth/password-reset/confirm", {
    method: "POST",
    body: JSON.stringify({ token, password }),
  });
}

export function createCampaign(input: {
  name: string;
  businessName: string;
  businessCategory: string;
  callToAction: string;
  landingUrl: string | null;
  offerDetails?: string | null;
  targetZipCodes: string[];
  radiusMiles: number;
  dailyBudgetCents: number;
  /** 7 or 14 days; null = always on. */
  runDays?: 7 | 14 | null;
  targetAddress?: TargetAddress | null;
  audienceFilters?: AudienceFilters | null;
  realty?: Realty | null;
}) {
  return api<Campaign>("/campaigns", { method: "POST", body: JSON.stringify(input) });
}

/** Draft edits. 409 `campaign_is_live` once launched. */
export function updateCampaign(
  campaignId: string,
  input: Partial<{
    audienceFilters: AudienceFilters | null;
    targetAddress: TargetAddress | null;
    radiusMiles: number;
    landingUrl: string | null;
    /** 400 `budget_below_minimum` under the currency's floor ($5/day USD). */
    dailyBudgetCents: number;
    /** 7 / 14 / null (always on). 409 `campaign_already_launched` after launch. */
    runDays: 7 | 14 | null;
  }>,
) {
  return api<Campaign>(`/campaigns/${campaignId}`, { method: "PATCH", body: JSON.stringify(input) });
}

/**
 * "Who should see it", before or after launch (PUT /campaigns/:id/targeting).
 * After launch Google gets it first; 502 `google_ads_error` (with `detail`)
 * means Google refused and nothing changed.
 */
export function updateTargeting(campaignId: string, input: { audienceFilters: AudienceFilters | null }) {
  return api<{ campaign: Campaign; appliedAtGoogle: boolean; changedAtGoogle?: boolean }>(
    `/campaigns/${campaignId}/targeting`,
    { method: "PUT", body: JSON.stringify(input) },
  );
}

/** One before & after pair (api lib/beforeAfter), with the photos' keys for thumbnails. */
export type BeforeAfterPair = { beforeAssetId: string; afterAssetId: string; beforeKey: string; afterKey: string };
export type BeforeAfterState = { allowed: boolean; pairs: BeforeAfterPair[]; attestedAt: string | null };

export function getBeforeAfter(campaignId: string) {
  return api<BeforeAfterState>(`/campaigns/${campaignId}/before-after`);
}

/** Saves the pairs (an empty list removes them). `attested` is required when any pair is sent. */
export function setBeforeAfter(
  campaignId: string,
  pairs: { beforeAssetId: string; afterAssetId: string }[],
  attested: boolean,
) {
  return api<BeforeAfterState>(`/campaigns/${campaignId}/before-after`, {
    method: "PUT",
    body: JSON.stringify({ pairs, attested }),
  });
}

/** One-click SiteVault website for a campaign with no website. */
export function createWebsite(
  campaignId: string,
  input: { phone: string; city: string; hours?: string; slug?: string; attest: true },
) {
  // With the $10 website fee: siteUrl null, pendingSite + a checkout to send them to.
  return api<{
    campaign: Campaign;
    siteUrl: string | null;
    editUrl: string;
    pendingSite?: PendingSite;
    checkout?: { redirectUrl: string | null } | null;
  }>(`/campaigns/${campaignId}/website`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** A made but unpaid SiteVault site ($10 website fee). paid = waiting for SiteVault to publish it. */
export type PendingSite = { siteUrl: string; paid: boolean; display: string | null };

/** A new checkout for the campaign's unpaid website. */
export function websiteCheckout(campaignId: string) {
  return api<{ checkout: { redirectUrl: string | null } }>(`/campaigns/${campaignId}/website/checkout`, { method: "POST" });
}

/** The site link and its private SiteVault edit link (owner only). */
/** Is the campaign's website actually up (SiteVault live and the page loads)? */
export const websiteReady = (campaignId: string) => api<{ ready: boolean }>(`/campaigns/${campaignId}/website/ready`);

export function getWebsite(campaignId: string) {
  // `campaign` is present when the site was renamed and the link was updated.
  return api<{
    siteUrl: string | null;
    editUrl: string | null;
    campaign?: Campaign;
    /** The account already has a SiteVault site (one per business): offer to reuse it. */
    accountSite?: { siteUrl: string; state?: string | null };
    /** REAL admins (test mode or not): may delete the account's site and make a new one. */
    adminCanDelete?: boolean;
    /** Admins outside test mode may also make another site without deleting. */
    adminCanMakeAnother?: boolean;
    /** Made but not paid for yet ($10 website fee). */
    pendingSite?: PendingSite;
    /** What "Make me a website" costs; null = free. Present only while there is no website. */
    websiteFee?: string | null;
    /** Offer combo: the latest paid website offer and whether it reached the site. */
    siteOffer?: { outcome: "updated" | "pending" | "retrying" | "failed"; offer: string | null } | null;
  }>(`/campaigns/${campaignId}/website`);
}

/** Use the account's existing SiteVault website for this campaign. */
export function linkExistingWebsite(campaignId: string) {
  return api<{ campaign: Campaign; siteUrl: string }>(`/campaigns/${campaignId}/website/use-existing`, { method: "POST" });
}

/** Admin only: delete the account's website for good (SiteVault + every link here), to make a new one. */
export function deleteAccountWebsite(campaignId: string, siteUrl: string) {
  return api<{ deleted: boolean; slug: string; unlinkedCampaigns: number }>(`/campaigns/${campaignId}/website/account-site/delete`, {
    method: "POST",
    body: JSON.stringify({ siteUrl }),
  });
}

export function generateCreatives(
  campaignId: string,
  input: {
    assetIds: string[];
    aspectRatios: ("16:9" | "9:16")[];
    peopleAssetIds?: string[];
    portraitAssetId?: string | null;
  },
) {
  return api<{ creatives: Creative[] }>(`/campaigns/${campaignId}/creatives/generate`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

// --- Keep it running: the paid new ad ---------------------------------------
// Subscribers on Keep it running pay per ad. The wizard orders and pays; the
// campaign page spends the paid order once the payment webhook lands.
export type NewAdStatus = {
  required: boolean;
  display: string | null;
  freeLaunchOffer: boolean;
  /** Redos left on the made ad; null when not metered (admin). */
  redosLeft: number | null;
  order: { id: string; status: string; amountMinor: number; currency: string } | null;
  /**
   * Offer combo: "Also put this offer on my website", when the campaign's
   * link is a SiteVault site with an offer and SiteVault answered. null = hide.
   */
  siteOffer: {
    offered: "paid" | "credit" | "free";
    offer: string;
    credits: number | null;
    addonDisplay: string | null;
  } | null;
};
/** Admins / at_cost: put the campaign's offer on its SiteVault site, free. */
export const pushFreeSiteOffer = (campaignId: string) =>
  api<{ purchaseId: string; pushed: boolean }>(`/campaigns/${campaignId}/site-offer`, { method: "POST" });
/** "Make it again": a new version from the same photos, replacing the current one. */
export const redoAd = (campaignId: string) =>
  api<{ creatives: Creative[] }>(`/campaigns/${campaignId}/creatives/redo`, { method: "POST" });
export const getNewAdQuote = () =>
  api<{ required: boolean; display?: string; freeLaunchOffer?: boolean }>("/new-ad/quote");
export const getNewAdStatus = (campaignId: string) => api<NewAdStatus>(`/campaigns/${campaignId}/new-ad`);
export const orderNewAd = (
  campaignId: string,
  input?: {
    assetIds?: string[];
    aspectRatios?: ("16:9" | "9:16")[];
    peopleAssetIds?: string[];
    portraitAssetId?: string | null;
    /** Offer combo: also put the campaign's offer on its SiteVault site. */
    siteOffer?: boolean;
  },
) =>
  api<{ purchaseId: string; checkout: { provider: string; redirectUrl: string | null } }>(
    `/campaigns/${campaignId}/new-ad/order`,
    { method: "POST", body: JSON.stringify(input ?? {}) },
  );
export const generatePaidNewAd = (purchaseId: string) =>
  api<{ creatives?: Creative[]; alreadyGenerated?: boolean }>(`/new-ad/orders/${purchaseId}/generate`, {
    method: "POST",
  });

export function launchCampaign(campaignId: string, adAccountId: string, videoOnWebsite?: boolean) {
  return api<{
    campaign: Campaign;
    zipCodesRequested: number;
    zipCodesTargeted: number;
    /** Real estate: radius around the listing; null for ZIP campaigns. */
    radiusMilesAroundAddress: number | null;
    audienceFiltersApplied: number;
    note: string;
    /** A test customer's launch is always a dry run: nothing went live. */
    validateOnly?: boolean;
    testCustomer?: boolean;
  }>(`/campaigns/${campaignId}/launch`, {
    method: "POST",
    body: JSON.stringify({ adAccountId, videoOnWebsite }),
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

// YouTube. Publishing to the org channel is the default and needs none of
// these — they exist for the advertiser who wants their ads on their own
// channel instead.
export const getYouTubeChannel = () => api<YouTubeChannelStatus>("/youtube/channel");

export const youtubeAuthorizeUrl = () => api<{ url: string }>("/youtube/authorize-url");

export const disconnectYouTubeChannel = () =>
  api<void>("/youtube/channel", { method: "DELETE" });

// Retries one creative's upload. The path out of a failed publish, and what
// makes a creative rendered before any channel existed usable later.
export const retryYouTubeUpload = (creativeId: string) =>
  api<{ queued: boolean }>(`/creatives/${creativeId}/youtube-upload`, { method: "POST" });

// Queues every rendered creative that never reached YouTube. For the advertiser
// who connects their own channel after the fact — published ads stay where they
// are, because YouTube has no concept of moving a video between channels.
export const backfillYouTubeUploads = () =>
  api<{ queued: number; creativeIds: string[] }>("/youtube/backfill", { method: "POST" });

// Two steps: ask the API for a presigned PUT, then upload straight to R2. The
// file never passes through the API, which is what keeps a 10MB storefront
// photo from occupying a Fastify worker for the length of a phone's upload.
// Phone photos are 3–12 MB at 4000+ px. The ad never needs more than ~2000 px
// (the video is 1080 wide), and the script writer (Claude, which looks at the
// photos) refuses images over 5 MB. So photos are re-encoded in the browser
// to at most 2048 px on the long edge, JPEG 0.88 (EXIF rotation applied).
// Anything that can't be decoded here is uploaded as it is.
const MAX_PHOTO_EDGE = 2048;
async function shrinkPhoto(file: File): Promise<File> {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type) || typeof createImageBitmap !== "function") return file;
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    const scale = Math.min(1, MAX_PHOTO_EDGE / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size <= 2_500_000) {
      bmp.close();
      return file;
    }
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.fillStyle = "#fff"; // a transparent PNG would otherwise turn black
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.88));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], file.name.replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" });
  } catch {
    return file;
  }
}

export async function uploadAsset(original: File, kind: "photo" | "logo" = "photo"): Promise<Asset> {
  const file = kind === "photo" ? await shrinkPhoto(original) : original;
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

// Width, height and length of a local video file, read by the browser.
function readVideoMeta(file: File): Promise<{ width: number; height: number; durationSeconds: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement("video");
    v.preload = "metadata";
    v.onloadedmetadata = () => {
      resolve({ width: v.videoWidth, height: v.videoHeight, durationSeconds: v.duration });
      URL.revokeObjectURL(url);
    };
    v.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("unreadable"));
    };
    v.src = url;
  });
}

// Upload a finished MP4 as a creative of this campaign. A customer's upload
// waits for AdVault's review before it is published or launched; an admin's is
// approved on upload. Same three steps as uploadAsset: presign, PUT straight
// to R2, confirm (with the rights attestation).
export async function uploadCreativeVideo(
  campaignId: string,
  file: File,
  limits: { minSeconds: number; maxSeconds: number },
): Promise<Creative> {
  if (file.type !== "video/mp4") throw new Error("not_mp4");
  if (file.size > 200 * 1024 * 1024) throw new Error("too_large");
  const meta = await readVideoMeta(file);
  // Same limits the API enforces, checked first so a bad file isn't uploaded.
  if (meta.durationSeconds < limits.minSeconds) throw new Error("too_short");
  if (meta.durationSeconds > limits.maxSeconds) throw new Error("too_long");
  const { creativeId, uploadUrl, contentType } = await api<{ creativeId: string; uploadUrl: string; contentType: string }>(
    `/campaigns/${campaignId}/creatives/upload-url`,
    { method: "POST", body: JSON.stringify(meta) },
  );
  const put = await fetch(uploadUrl, { method: "PUT", headers: { "content-type": contentType }, body: file });
  if (!put.ok) throw new ApiError(put.status, "upload_failed");
  return api<Creative>(`/campaigns/${campaignId}/creatives/upload`, {
    method: "POST",
    body: JSON.stringify({ ...meta, creativeId, rightsAttested: true }),
  });
}

// Remove an uploaded video from a campaign that is not live.
export const removeUploadedCreative = (creativeId: string) =>
  api<void>(`/creatives/${creativeId}`, { method: "DELETE" });

// --- admin: uploaded-video review --------------------------------------------

export type VideoReview = {
  creativeId: string;
  campaignId: string;
  campaignName: string;
  businessName: string;
  landingUrl: string | null;
  campaignStatus: CampaignStatus;
  ownerEmail: string;
  aspectRatio: "16:9" | "9:16";
  durationSeconds: number | null;
  sizeBytes: number | null;
  reviewStatus: VideoReviewStatus;
  reviewedAt: string | null;
  reviewReason: string | null;
  rightsAttestedAt: string | null;
  rightsAttestedBy: string | null;
  createdAt: string;
  /** Ten-minute playback link. */
  videoUrl: string | null;
};

export const listVideoReviews = (status: VideoReviewStatus = "pending_review") =>
  api<{ status: VideoReviewStatus; videos: VideoReview[] }>(`/admin/video-reviews?status=${status}`);

export const decideVideoReview = (
  creativeId: string,
  input: { decision: "approve" } | { decision: "reject"; reason: string },
) => api<Creative>(`/admin/video-reviews/${creativeId}`, { method: "POST", body: JSON.stringify(input) });

// --- admins --------------------------------------------------------------

export type AdminUser = {
  id: string;
  email: string;
  displayName: string | null;
  businessName: string | null;
  role: "advertiser" | "admin";
  signupApp: "advault" | "sitevault";
  isInternal?: boolean;
  internalLabel?: string | null;
  createdAt: string;
};

export const listAdminUsers = (q = "") =>
  api<{ users: AdminUser[] }>(`/admin/users${q ? `?q=${encodeURIComponent(q)}` : ""}`);

export const setUserRole = (id: string, role: AdminUser["role"]) =>
  api<{ user: AdminUser }>(`/admin/users/${id}/role`, { method: "POST", body: JSON.stringify({ role }) });

/** 3PandaLabs' own accounts (0032): full price, left out of revenue. */
export const listInternalAccounts = () => api<{ users: AdminUser[] }>("/admin/internal-accounts");

export const setInternalAccount = (email: string, internal: boolean, label?: string) =>
  api<{ user: AdminUser }>("/admin/internal-accounts", {
    method: "POST",
    body: JSON.stringify({ email, internal, ...(label ? { label } : {}) }),
  });

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
  /**
   * The budget picture for the banners (live, platform-funded campaigns).
   * idle = nothing running; low = under max(2 days, $10); empty = paused (or
   * about to be) because the budget ran out.
   */
  budget?: {
    state: "idle" | "ok" | "low" | "empty";
    daysLeft: number | null;
    liveDailyMinor: number;
    liveCampaignIds: string[];
    pausedForFunds: { id: string; name: string }[];
  };
  entries: LedgerEntry[];
};

export const getWallet = () => api<Wallet>("/wallet");

/** `campaignId`: checkout returns to that campaign page instead of the wallet. */
export function topUp(amountMinor: number, campaignId?: string) {
  return api<{
    paymentId: string;
    provider: "razorpay" | "stripe" | "manual";
    redirectUrl: string | null;
    clientPayload: Record<string, unknown>;
  }>("/wallet/topup", { method: "POST", body: JSON.stringify({ amountMinor, ...(campaignId ? { campaignId } : {}) }) });
}

// Creates the managed (MCC) child account.
//
// `billingMode` is required whenever the deployment offers both — the API
// refuses to guess, because defaulting would silently put an advertiser on
// AdVault's credit card. Call billingOptions() first.
// `campaignId` is the campaign that prompted setup; its budget sizes the first
// spending limit on the customer's card (platform billing).
export const provisionManagedAccount = (billingMode?: BillingMode, campaignId?: string) =>
  api<AdAccount & { invitationSent?: boolean; billingWarning?: string; billingDetail?: string }>(
    "/ad-accounts/managed",
    {
      method: "POST",
      body: JSON.stringify({
        ...(billingMode ? { billingMode } : {}),
        ...(campaignId ? { campaignId } : {}),
      }),
    },
  );

/**
 * A platform-billed account waiting for 3PandaLabs to add its card in Google
 * Ads. The customer has nothing to do; launch unlocks on its own.
 */
export function isAwaitingPlatformSetup(a: AdAccount): boolean {
  return a.isManaged && a.billingMode === "platform" && a.billingLinkStatus === "pending";
}

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
  line: "offer" | "managed" | "evergreen";
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
  // testMode: the signed-in admin is testing as a customer; plan fees are the test price.
  return api<{ currency: string; plans: Plan[]; testMode?: boolean }>(`/plans?currency=${encodeURIComponent(currency)}`);
}

export type SubscriptionView = {
  subscription: {
    id: string;
    planKey: string;
    line: "offer" | "managed" | "evergreen";
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

export type DeletionPreview = {
  liveCampaigns: number;
  activePlan: boolean;
  walletBalanceMinor: number;
  currencyCode: string;
};

export function getDeletionPreview() {
  return api<DeletionPreview>("/auth/me/deletion");
}

/** 204 on success; ApiError 403 "wrong_password". */
export function deleteAccount(password: string) {
  return api<void>("/auth/me/delete", { method: "POST", body: JSON.stringify({ password }) });
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
  /** Unspent 3-pack credits; while > 0 an order costs nothing more. */
  creditsLeft: number;
  /** The 3-pack offer, or null where it isn't sold. */
  pack: { addOnKey: string; credits: number; priceMinor: number; display: { price: string; each: string } } | null;
};

export function cinematicQuote() {
  return api<CinematicQuote>("/cinematic/quote");
}

export function buyCinematicPack() {
  return api<{
    purchase: { id: string };
    checkout: { provider: string; redirectUrl: string | null; clientPayload: Record<string, unknown> | null };
  }>("/cinematic/packs", { method: "POST" });
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

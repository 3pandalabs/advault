import { GOOGLE_ADS_API_BASE, googleAdsEnv } from "./env.js";

export class GoogleAdsApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

// Minimal REST client. The official `google-ads-api` npm package is a large
// generated dependency, and this app calls four endpoints — not worth the
// install size or the version-pinning surface in a container that also has to
// stay small enough to sit alongside three other apps on one box.
async function call<T>(
  path: string,
  accessToken: string,
  init: { method: "GET" | "POST"; body?: unknown; loginCustomerId?: string | null },
): Promise<T> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${accessToken}`,
    "developer-token": googleAdsEnv.developerToken!,
  };
  // Required whenever the target customer is reached through a Manager (MCC)
  // account, which is the normal shape here. Digits only — a dashed id reaches
  // Google as a 400 that reads like an auth failure.
  const login = init.loginCustomerId ?? googleAdsEnv.loginCustomerId;
  if (login) headers["login-customer-id"] = login.replace(/-/g, "");
  if (init.body) headers["content-type"] = "application/json";

  const res = await fetch(`${GOOGLE_ADS_API_BASE}${path}`, {
    method: init.method,
    headers,
    body: init.body ? JSON.stringify(init.body) : undefined,
  });

  const json = (await res.json().catch(() => null)) as
    | { error?: { message?: string; details?: unknown } }
    | null;

  if (!res.ok) {
    throw new GoogleAdsApiError(
      json?.error?.message ?? `Google Ads API ${res.status}`,
      res.status,
      json?.error?.details,
    );
  }
  return json as T;
}

// The customer ids this OAuth grant can reach, as resource names
// ("customers/1234567890"). Called right after the token exchange so the
// advertiser picks from real accounts rather than typing an id from memory.
export async function listAccessibleCustomers(accessToken: string): Promise<string[]> {
  const body = await call<{ resourceNames?: string[] }>(
    "/customers:listAccessibleCustomers",
    accessToken,
    { method: "GET" },
  );
  return body.resourceNames ?? [];
}

export type CustomerDetails = {
  customerId: string;
  descriptiveName: string | null;
  currencyCode: string | null;
  timeZone: string | null;
  isTestAccount: boolean;
};

// GAQL rather than the REST resource getter, because one search returns every
// field the ad_accounts row needs in a single round trip.
export async function getCustomerDetails(
  accessToken: string,
  customerId: string,
  loginCustomerId?: string | null,
): Promise<CustomerDetails | null> {
  const body = await call<{
    results?: {
      customer?: {
        id?: string;
        descriptiveName?: string;
        currencyCode?: string;
        timeZone?: string;
        testAccount?: boolean;
      };
    }[];
  }>(`/customers/${customerId}/googleAds:search`, accessToken, {
    method: "POST",
    loginCustomerId,
    body: {
      query:
        "SELECT customer.id, customer.descriptive_name, customer.currency_code, " +
        "customer.time_zone, customer.test_account FROM customer LIMIT 1",
    },
  });

  const c = body.results?.[0]?.customer;
  if (!c?.id) return null;

  return {
    customerId: c.id,
    descriptiveName: c.descriptiveName ?? null,
    currencyCode: c.currencyCode ?? null,
    timeZone: c.timeZone ?? null,
    // Google rejects mutate operations against a test account with a
    // production developer token and vice versa. Recording this at connect
    // time turns that into a clear message at launch instead of a confusing
    // permissions error.
    isTestAccount: Boolean(c.testAccount),
  };
}

export { call as googleAdsCall };

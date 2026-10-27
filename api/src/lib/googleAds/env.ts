import "dotenv/config";

// ⚠️ DEVELOPER TOKENS WERE SUNSET BY GOOGLE ON 9 SEP 2026.
//
// This app was built against the old world, where the developer token was the
// slow gate: Basic access meant a manual review against a Manager (MCC)
// account and could take days. That gate is gone. API access level is now a
// property of the GOOGLE CLOUD PROJECT whose OAuth credentials you use, and new
// Basic/Standard applications are gated on brand verification plus active paid
// billing on that project instead. Tokens may still be sent in the header but
// Google ignores them, and releases in the first half of 2027 will reject them.
//
// Consequences for this file, both applied:
//  - `developerToken` is optional and NOT part of isGoogleAdsConfigured().
//    Requiring it made every launch answer 503 while waiting for a credential
//    Google no longer issues.
//  - The header is sent only when one happens to be configured, so an existing
//    deployment keeps working unchanged.
//
// Routes consult isGoogleAdsConfigured() and answer 503 with a specific error
// code when it is false, so the dashboard can say "connect pending setup"
// rather than failing with something that looks like a bug.
export const googleAdsEnv = {
  clientId: process.env.GOOGLE_ADS_CLIENT_ID,
  clientSecret: process.env.GOOGLE_ADS_CLIENT_SECRET,
  // Vestigial: ignored by Google's servers since 9 Sep 2026, rejected from
  // 2027. Kept so an existing deployment's env var is not suddenly an error.
  developerToken: process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
  // Manager (MCC) account that fronts API calls. Digits only — the dashboard's
  // dashed display format is rejected by the API.
  loginCustomerId: process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID,
};

// The OAuth scope needed to read and mutate an advertiser's campaigns. There is
// no narrower Google Ads scope — the API is all-or-nothing per account, which
// is worth stating plainly on the consent screen copy in web/.
export const GOOGLE_ADS_SCOPE = "https://www.googleapis.com/auth/adwords";

export const GOOGLE_OAUTH_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_OAUTH_REVOKE_URL = "https://oauth2.googleapis.com/revoke";

// Pinned rather than floating. Google Ads API versions are retired on a fixed
// schedule and a silently-newer version can change response shapes under us —
// see infra/google-ads-setup.md for the upgrade cadence.
//
// ⚠️ This was pinned to v18 until 2026-10-24. v18 SUNSET ON 2025-08-20 — every
// Google Ads call this app could make had been dead for over a year, and
// nothing noticed because no launch had ever reached Google: the 503 from
// isGoogleAdsConfigured() (waiting on a developer token) masked it completely.
// An expired pin here is not deferred maintenance, it is a silent total outage
// of the only feature that spends money. Check the schedule when touching it:
// https://developers.google.com/google-ads/api/docs/sunset-dates
export const GOOGLE_ADS_API_VERSION = "v26";
export const GOOGLE_ADS_API_BASE = `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}`;

// OAuth alone is enough to *connect* an account (authorize + token exchange +
// listing accessible customers all work without a developer token). Both
// predicates now test the same thing, and they are kept separate deliberately:
// access level is a property of the Cloud project, which this process has no
// way to interrogate, so a project without Basic access now fails at the first
// mutate call rather than here. Collapsing them would make that harder to
// reinstate when Google next moves the gate.
export function isOAuthConfigured(): boolean {
  return Boolean(googleAdsEnv.clientId && googleAdsEnv.clientSecret);
}

export function isGoogleAdsConfigured(): boolean {
  return isOAuthConfigured();
}

// Must match an Authorised redirect URI on the OAuth client exactly — Google
// compares the whole string, including scheme, port and trailing slash. Built
// from WEB_ORIGIN so localhost and production don't drift apart.
export function redirectUri(webOrigin: string): string {
  return `${webOrigin.replace(/\/$/, "")}/oauth/google/callback`;
}

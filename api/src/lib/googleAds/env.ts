import "dotenv/config";

// Optional, like the script generator's key — but for a different reason. The
// Google Ads developer token is the slow part of standing this app up: Basic
// access is a manual review against an existing Manager (MCC) account and can
// take days. Everything up to "launch this campaign" must work without it, or
// the product is unbuildable until Google replies.
//
// Routes consult isGoogleAdsConfigured() and answer 503 with a specific error
// code when it is false, so the dashboard can say "connect pending setup"
// rather than failing with something that looks like a bug.
export const googleAdsEnv = {
  clientId: process.env.GOOGLE_ADS_CLIENT_ID,
  clientSecret: process.env.GOOGLE_ADS_CLIENT_SECRET,
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
export const GOOGLE_ADS_API_VERSION = "v18";
export const GOOGLE_ADS_API_BASE = `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}`;

// OAuth alone is enough to *connect* an account (authorize + token exchange +
// listing accessible customers all work without a developer token). Only the
// campaign-mutating calls need the full set, which is why these are separate.
export function isOAuthConfigured(): boolean {
  return Boolean(googleAdsEnv.clientId && googleAdsEnv.clientSecret);
}

export function isGoogleAdsConfigured(): boolean {
  return isOAuthConfigured() && Boolean(googleAdsEnv.developerToken);
}

// Must match an Authorised redirect URI on the OAuth client exactly — Google
// compares the whole string, including scheme, port and trailing slash. Built
// from WEB_ORIGIN so localhost and production don't drift apart.
export function redirectUri(webOrigin: string): string {
  return `${webOrigin.replace(/\/$/, "")}/oauth/google/callback`;
}

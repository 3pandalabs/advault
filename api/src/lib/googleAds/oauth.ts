import {
  GOOGLE_ADS_SCOPE,
  GOOGLE_OAUTH_AUTH_URL,
  GOOGLE_OAUTH_REVOKE_URL,
  GOOGLE_OAUTH_TOKEN_URL,
  googleAdsEnv,
  redirectUri,
} from "./env.js";
import { env } from "../../env.js";

export class GoogleOAuthError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export function buildAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: googleAdsEnv.clientId!,
    redirect_uri: redirectUri(env.WEB_ORIGIN),
    response_type: "code",
    scope: GOOGLE_ADS_SCOPE,
    state,
    // Both are required to get a refresh token at all. Without access_type
    // offline Google returns only a one-hour access token, and without
    // prompt=consent it omits the refresh token on every authorization after
    // the first — so a reconnect would appear to succeed and then have nothing
    // to refresh with.
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
  });
  return `${GOOGLE_OAUTH_AUTH_URL}?${params.toString()}`;
}

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  token_type: string;
};

export async function exchangeCodeForTokens(code: string): Promise<TokenResponse> {
  const res = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: googleAdsEnv.clientId!,
      client_secret: googleAdsEnv.clientSecret!,
      redirect_uri: redirectUri(env.WEB_ORIGIN),
      grant_type: "authorization_code",
    }),
  });

  const body = (await res.json().catch(() => null)) as (TokenResponse & { error?: string }) | null;
  if (!res.ok || !body?.access_token) {
    throw new GoogleOAuthError(
      `Token exchange failed: ${body?.error ?? res.status}`,
      "token_exchange_failed",
    );
  }
  return body;
}

// Mints a short-lived access token from the stored refresh token. Called on
// every API operation rather than cached — access tokens live an hour, the call
// is cheap, and a cache is one more place for a stale credential to hide.
export async function refreshAccessToken(refreshToken: string): Promise<string> {
  const res = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: googleAdsEnv.clientId!,
      client_secret: googleAdsEnv.clientSecret!,
      grant_type: "refresh_token",
    }),
  });

  const body = (await res.json().catch(() => null)) as
    | (TokenResponse & { error?: string })
    | null;

  if (!res.ok || !body?.access_token) {
    // invalid_grant is the one error worth distinguishing: the advertiser
    // revoked access, changed their password, or the token expired from
    // disuse. It is permanent — retrying is pointless — and the caller marks
    // the ad_accounts row 'revoked' so the dashboard prompts a reconnect
    // instead of failing every launch with the same opaque message.
    throw new GoogleOAuthError(
      `Refresh failed: ${body?.error ?? res.status}`,
      body?.error === "invalid_grant" ? "invalid_grant" : "refresh_failed",
    );
  }
  return body.access_token;
}

// Best-effort: tells Google to drop the grant when an advertiser disconnects.
// Deliberately non-throwing — the local row is deleted either way, and leaving
// a disconnect half-done because Google was briefly unreachable is worse than
// an orphaned grant the advertiser can also revoke from their Google account.
export async function revokeRefreshToken(refreshToken: string): Promise<void> {
  await fetch(GOOGLE_OAUTH_REVOKE_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: refreshToken }),
  }).catch(() => undefined);
}

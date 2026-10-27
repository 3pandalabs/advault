import { env } from "../../env.js";
import { googleAdsEnv, GOOGLE_OAUTH_AUTH_URL } from "../googleAds/env.js";
import { YOUTUBE_API_BASE, YOUTUBE_SCOPE } from "./env.js";

// The advertiser-owned channel grant. Token exchange, refresh and revoke are
// reused wholesale from lib/googleAds/oauth.ts — they are parameterised by the
// OAuth client, not by the scope, and this flow uses the same client. Only the
// authorize URL and the channel lookup are specific to YouTube.

export function buildYouTubeAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: googleAdsEnv.clientId!,
    redirect_uri: youtubeRedirectUri(env.WEB_ORIGIN),
    response_type: "code",
    scope: YOUTUBE_SCOPE,
    state,
    // Both required to get a refresh token at all — without access_type
    // offline Google returns a one-hour access token only, and without
    // prompt=consent it omits the refresh token on every authorization after
    // the first, so a reconnect appears to succeed with nothing to refresh.
    access_type: "offline",
    prompt: "consent",
    // Deliberately NOT include_granted_scopes here, unlike the Ads flow. An
    // advertiser who has already granted adwords should see a consent screen
    // that says "upload videos to your YouTube channel" and nothing else —
    // merging the grants would hide what they are actually agreeing to.
  });
  return `${GOOGLE_OAUTH_AUTH_URL}?${params.toString()}`;
}

// Its own callback path, separate from the Ads one. Must match an Authorised
// redirect URI on the OAuth client exactly — Google compares the whole string.
export function youtubeRedirectUri(webOrigin: string): string {
  return `${webOrigin.replace(/\/$/, "")}/oauth/youtube/callback`;
}

export type YouTubeChannelIdentity = { channelId: string; title: string | null };

// Which channel does this grant actually upload to? Called once at connect
// time: an advertiser who owns several channels needs to see which one we got,
// and storing it means every later upload needs no extra round trip.
export async function fetchOwnChannel(accessToken: string): Promise<YouTubeChannelIdentity | null> {
  const res = await fetch(`${YOUTUBE_API_BASE}/channels?part=snippet&mine=true`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });

  const body = (await res.json().catch(() => null)) as {
    items?: { id?: string; snippet?: { title?: string } }[];
  } | null;

  if (!res.ok) return null;

  const item = body?.items?.[0];
  // An account with no channel returns 200 and an empty list rather than an
  // error. Treated as "no channel" by the caller, which is a real case: a
  // Google account is not a YouTube channel until someone creates one, and
  // local-business owners routinely have the former and not the latter.
  if (!item?.id) return null;

  return { channelId: item.id, title: item.snippet?.title ?? null };
}

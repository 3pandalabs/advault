import "dotenv/config";
import { googleAdsEnv } from "../googleAds/env.js";

// YouTube, which is a hard prerequisite for an ad existing at all.
//
// A Google Ads video ad references an 11-character YouTube video id — never an
// MP4 URL. Rendering a file is therefore only half of producing an ad; until it
// is on a channel, a launched campaign is a budgeted shell that can never show
// anything. That was the state of this app until this module existed.
//
// The OAuth client is deliberately the same one the Google Ads flow uses:
// same Google Cloud project, one consent screen to maintain, and — since
// 9 Sep 2026 — the Cloud project is what determines Google Ads API access
// level, so splitting clients across projects would mean maintaining that
// approval twice. Only the scopes differ.

// youtube.upload alone cannot read which channel it is uploading to, and
// Settings has to be able to say "connected to <channel>" without making the
// advertiser trust an unnamed grant. readonly is the narrowest scope that
// answers channels.list(mine=true); there is nothing smaller.
export const YOUTUBE_SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
] as const;

export const YOUTUBE_SCOPE = YOUTUBE_SCOPES.join(" ");

export const YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3";
export const YOUTUBE_UPLOAD_BASE = "https://www.googleapis.com/upload/youtube/v3";

// The org channel's own refresh token — one credential for the whole platform,
// not one per advertiser, exactly like the MCC token. Encrypted at rest with
// the same key; see infra/youtube-setup.md for how to mint it.
const ORG_REFRESH_TOKEN_CIPHERTEXT = process.env.YOUTUBE_ORG_REFRESH_TOKEN_CIPHERTEXT;

// Display only — which channel the org token belongs to, so /metrics and the
// dashboard can name it without an API call.
export const YOUTUBE_ORG_CHANNEL_ID = process.env.YOUTUBE_ORG_CHANNEL_ID ?? null;
export const YOUTUBE_ORG_CHANNEL_TITLE = process.env.YOUTUBE_ORG_CHANNEL_TITLE ?? null;

export function orgRefreshTokenCiphertext(): string | undefined {
  return ORG_REFRESH_TOKEN_CIPHERTEXT;
}

// Can an advertiser connect their OWN channel? Needs only the OAuth client,
// because the grant itself comes from them.
export function isYouTubeOAuthConfigured(): boolean {
  return Boolean(googleAdsEnv.clientId && googleAdsEnv.clientSecret);
}

// Can we upload on an advertiser's behalf with no action from them? Needs the
// platform credential. This is the one that gates the managed Option A funnel,
// where the advertiser has no channel and must never be asked to make one.
export function isOrgChannelConfigured(): boolean {
  return isYouTubeOAuthConfigured() && Boolean(ORG_REFRESH_TOKEN_CIPHERTEXT);
}

// True when *some* upload path exists. Checked before a render is enqueued for
// upload, and reported by /metrics: with neither credential present every
// creative renders fine and no campaign can ever serve, which is precisely the
// failure this app has already shipped once.
export function isYouTubeConfigured(): boolean {
  return isYouTubeOAuthConfigured();
}

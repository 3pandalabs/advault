# YouTube — the org channel credential

**Without this, no AdVault campaign can serve.** A Google Ads video ad
references an 11-character YouTube video id, never an MP4 URL, so every rendered
creative has to be published to a YouTube channel before it can be attached to a
campaign. `render/youtubeUploads.ts` does that; this file is how it gets a
credential.

Two shapes exist, and the default is the one that matters:

| Shape | Credential | Who it is for |
|---|---|---|
| **Org channel** (default) | One platform-wide refresh token in the renderer's env | Everyone, and the **only** shape that works for a managed Option A advertiser — a local shop that has no YouTube channel and must never be asked to make one mid-signup |
| Advertiser's own channel | A per-user grant in `youtube_channels`, collected in Settings | The advertiser who wants to own the videos |

The advertiser path needs nothing here beyond the OAuth client from
`infra/google-ads-setup.md` — the grant comes from them. The rest of this file
is the org channel.

## 1. Create the channel

On **3pandalabs@gmail.com**, per the org account convention. YouTube → create a
channel. Name it something an advertiser seeing it in Google Ads will recognise
as the publisher of their ad, not as a stranger's channel.

Note the channel id (`UC…`) from Settings → Advanced settings. That is
`YOUTUBE_ORG_CHANNEL_ID` — display only, so the dashboard and `/metrics` can
name the channel without an API call.

> **Verify the channel before any volume goes through it.** A fresh,
> unverified channel's upload quota is small (on the order of a handful of
> videos per day), and `MAX_CREATIVES_PER_DAY` is 20 — so the quota, not the
> code, is the first thing that will break. A `quotaExceeded` upload is treated
> as retryable with backoff, so it recovers on its own, but the ads are late.

## 2. Mint the refresh token

The YouTube Data API is enabled on the same Cloud project as the Google Ads API
(step 3 of `infra/google-ads-setup.md`), and the same OAuth client is used. The
org token is minted by hand, once, the same way the MCC token is.

Open this URL, signed in as the channel owner, with the client id substituted:

```
https://accounts.google.com/o/oauth2/v2/auth
  ?client_id=<GOOGLE_ADS_CLIENT_ID>
  &redirect_uri=http://localhost:3000/oauth/youtube/callback
  &response_type=code
  &scope=https://www.googleapis.com/auth/youtube.upload%20https://www.googleapis.com/auth/youtube.readonly
  &access_type=offline
  &prompt=consent
```

`access_type=offline` **and** `prompt=consent` are both required or Google
returns no refresh token at all — see the comment in `lib/youtube/oauth.ts`.

Take the `code` from the redirect and exchange it:

```sh
curl -s https://oauth2.googleapis.com/token \
  -d client_id=<GOOGLE_ADS_CLIENT_ID> \
  -d client_secret=<GOOGLE_ADS_CLIENT_SECRET> \
  -d redirect_uri=http://localhost:3000/oauth/youtube/callback \
  -d grant_type=authorization_code \
  -d code=<CODE>
```

The code is single-use and expires in minutes; a second attempt needs a fresh
authorize round trip.

## 3. Encrypt it and set the env vars

The column and the env var both hold **ciphertext**, never a usable token — the
same treatment as the Google Ads tokens, because a grant that can publish to a
channel is its own kind of damage. Encrypt with the deployment's
`TOKEN_ENCRYPTION_KEY` using the app's own helper so the format matches
`decryptToken()` exactly:

```sh
# from api/, with TOKEN_ENCRYPTION_KEY set in the environment
node --input-type=module -e '
  const { encryptToken } = await import("./dist/lib/crypto.js");
  console.log(encryptToken(process.argv[1]));
' "<refresh token>"
```

Then on **`advault-renderer`** (not the API — the upload worker runs in the
renderer):

```
YOUTUBE_ORG_REFRESH_TOKEN_CIPHERTEXT=<output above>
YOUTUBE_ORG_CHANNEL_ID=UC...
YOUTUBE_ORG_CHANNEL_TITLE=<channel name>
```

The renderer also needs `GOOGLE_ADS_CLIENT_ID` and `GOOGLE_ADS_CLIENT_SECRET`,
which it did not before this feature existed.

> **Coolify's API token is read+deploy only** — it cannot write env vars (403
> "Missing required permissions: write"). Set these in the Coolify UI.

Redeploy. The renderer should log:

```
youtube upload worker started
```

and **not**:

```
youtube uploads disabled — no OAuth client configured; campaigns cannot serve
```

## 4. Verify end to end

Container health, `/health` and a green deploy all pass while the app's actual
job is broken — that is the org's recurring trap (the v1 missing fonts, the R2
CORS/checksum pair). The only honest test is a real publish:

1. Render a creative.
2. Watch `GET /metrics` → `counts.queuedYoutubeUploads` go 1 → 0 and
   `counts.creativesOnYouTube` increase.
3. Confirm the video exists on the channel as **unlisted**.
4. Confirm the campaign page's badge reads **Ready**, not **Publishing…**.
5. Launch, and confirm in the Google Ads UI that the campaign has an ad group
   with an ad in it — not just a budget.

## What to watch afterwards

`counts.renderedNotOnYouTube` is the metric that matters. It climbs silently
while every render metric stays green, and every creative it counts is an ad
that cannot be attached to a campaign. `counts.failedYoutubeUploads` is the
work-item version of the same thing.

`counts.liveCampaignsWithoutAds` should be **0 forever**. Anything else means a
campaign is budgeted at Google with no ad in it — the exact bug the upload chain
was built to remove.

## Policy notes that are code, not preference

- **Uploads are `unlisted`, never public.** A video ad serves perfectly well
  from an unlisted video, and public would put every local shop's ad into the
  org channel's public feed and its subscribers' timelines. `notifySubscribers`
  is irrelevant for the same reason.
- **`containsSyntheticMedia` is derived, not hardcoded.** A Kling/Luma clip or a
  synthesised voiceover is altered or synthetic media under YouTube's rules, and
  the default pipeline (Ken Burns stills, no voice) is neither — so the flag
  comes from the creative's recorded `motion_source` / `voice_source`. The
  privacy policy states this; changing the derivation changes a published claim.
- **A published creative is never re-published.** The upload worker skips a
  creative that already has a video id, and the edit/retry routes refuse a
  creative with a `google_ad_resource_name` — a live ad points at a *specific*
  video, so a second upload would leave the ad showing the old cut with nothing
  recording the swap.

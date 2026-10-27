# Google Ads — OAuth client and API access

**Start this first.** Google Ads API access is the only thing standing between a
working AdVault and a launching AdVault. Everything else — signup, uploads,
script generation, rendering, downloads — works without any of it.

> ⚠️ **Rewritten 2026-10-24. Developer tokens were sunset on 9 September 2026**
> and the process in the previous version of this file no longer exists. If you
> are following instructions that say "apply for a Basic access developer token
> in the API Center", they are out of date — the API Center page moved and the
> token is no longer what grants access.

## How access works now

API access level is a property of the **Google Cloud project** whose OAuth
credentials you use, not of a token you paste into the environment:

| What you need | Unlocks | How long |
|---|---|---|
| Google Cloud project with the Google Ads API enabled | Nothing on its own | Minutes |
| OAuth client id + secret on that project | Connecting an account, listing accessible customers | Minutes |
| **Brand verification** on that Cloud project | Prerequisite for applying for Basic | Days — Google reviews it |
| **Active paid billing** on that Cloud project | Prerequisite for Basic (a free trial does not qualify) | Minutes |
| **Basic access** on the project | Creating campaigns — i.e. launching | Minutes once verification passes (automated review) |
| Manager (MCC) account | Child-account provisioning and platform billing | Same day |

Sign-up and access management live on the **Google Ads API Overview page in the
Google Cloud Console**, not in the Google Ads manager account's API Center.

A developer token may still be sent in the request header — Google ignores it,
and releases in the first half of 2027 will reject it. `googleAdsEnv.developerToken`
is therefore optional and is deliberately **not** part of `isGoogleAdsConfigured()`:
requiring it made every launch answer 503 while waiting for a credential Google
no longer issues. `GOOGLE_ADS_DEVELOPER_TOKEN` can be left unset on a fresh
install, and an existing one is passed through harmlessly.

`isOAuthConfigured()` and `isGoogleAdsConfigured()` in
`api/src/lib/googleAds/env.ts` are kept separate even though they now test the
same thing. Access level is a property of the Cloud project, which the process
cannot interrogate, so **a project without Basic access fails at the first
mutate call rather than at the predicate** — the error arrives as a Google Ads
API error at launch, not as a clean "not switched on yet" 503.

## 1. Manager (MCC) account

Create one at [ads.google.com/home/tools/manager-accounts](https://ads.google.com/home/tools/manager-accounts)
under **3pandalabs@gmail.com**, per the org's account convention (org-owned
account, brand email). Note its customer id — digits only, no dashes. That is
`GOOGLE_ADS_LOGIN_CUSTOMER_ID`.

## 2. Cloud project, brand verification and Basic access

[console.cloud.google.com](https://console.cloud.google.com) → the project whose
OAuth client AdVault uses → **Google Ads API Overview**:

1. Enable the **Google Ads API**.
2. Make sure the project is on **active paid billing**. A free trial or a
   suspended billing account does not qualify for Basic access.
3. Complete **brand verification** for the project. This gates every new Basic
   and Standard application and is the slow step — start it on day one.
4. Apply for **Basic access**. Reviews are automated and usually return within
   minutes once brand verification has passed.

Test access still exists and still only works against *test* accounts: Google
rejects mutate operations against a production account with test-level access
and vice versa. That is why `ad_accounts.is_test_account` is recorded at connect
time, so the mismatch surfaces as a clear message rather than a confusing
permissions error.

## 3. Google Cloud OAuth client

[console.cloud.google.com](https://console.cloud.google.com) → **the same
project as step 2** (its access level is what grants Basic, so a second project
would need its own brand verification) → APIs & Services:

1. Enable the **Google Ads API** and the **YouTube Data API v3**. The second one
   is not optional: without it no ad can be published, and therefore no campaign
   can serve. See `infra/youtube-setup.md`.
2. OAuth consent screen — External. Add three scopes:
   - `https://www.googleapis.com/auth/adwords` — the only Google Ads scope there
     is; it is all-or-nothing per account, which is why the Settings page says so
     in plain words rather than implying a narrower permission.
   - `https://www.googleapis.com/auth/youtube.upload` — publishing an ad.
   - `https://www.googleapis.com/auth/youtube.readonly` — reading back *which*
     channel a grant uploads to, so Settings can name it.
3. Credentials → Create OAuth client ID → **Web application**. One client serves
   both flows; only the scopes differ.
4. Authorised redirect URIs — **all four**, exactly:

```
https://advault.3pandalabs.com/oauth/google/callback
http://localhost:3000/oauth/google/callback
https://advault.3pandalabs.com/oauth/youtube/callback
http://localhost:3000/oauth/youtube/callback
```

**Google compares the entire redirect string** — scheme, host, port, path,
trailing slash. The API derives it from `WEB_ORIGIN` (`redirectUri()` in
`lib/googleAds/env.ts`) so the two cannot drift, but the values above must
appear verbatim in the console or the callback fails with `redirect_uri_mismatch`.

While the consent screen is in **Testing**, only accounts on its test-user list
can complete the flow. Add your own before smoke testing, or publish it.

## 4. Set the env vars

⚠️ **The renderer needs the OAuth client too, as of 2026-10-24.** It used to be
true that only the API talked to Google; the YouTube upload worker runs in the
renderer (`render/youtubeUploads.ts`), so it needs the client pair and the org
channel token. A renderer without them logs
`youtube uploads disabled — no OAuth client configured` on boot and every
creative renders fine and can never become an ad.

On **`advault-api`**:

```
GOOGLE_ADS_CLIENT_ID=<client id>.apps.googleusercontent.com
GOOGLE_ADS_CLIENT_SECRET=<client secret>
GOOGLE_ADS_LOGIN_CUSTOMER_ID=<MCC customer id, digits only>
```

On **`advault-renderer`**, the same client pair plus the channel credential
(`infra/youtube-setup.md` covers minting it):

```
GOOGLE_ADS_CLIENT_ID=<client id>.apps.googleusercontent.com
GOOGLE_ADS_CLIENT_SECRET=<client secret>
YOUTUBE_ORG_REFRESH_TOKEN_CIPHERTEXT=<encrypted refresh token>
YOUTUBE_ORG_CHANNEL_ID=<UC...>
YOUTUBE_ORG_CHANNEL_TITLE=<channel name, display only>
```

`GOOGLE_ADS_DEVELOPER_TOKEN` is **no longer needed anywhere** — developer tokens
were sunset on 9 Sep 2026. An existing value is passed through harmlessly; a
fresh install should simply omit it.

Redeploy. `GET /ad-accounts` now returns `configured: true`.

> **Coolify's API token is read+deploy only** — it cannot write env vars (403
> "Missing required permissions: write"). Set these in the Coolify UI.

## Why the flow is shaped the way it is

- **`access_type=offline` + `prompt=consent`** are both mandatory. Without
  offline access Google returns only a one-hour access token; without
  `prompt=consent` it omits the refresh token on every authorization after the
  first — so a reconnect appears to succeed and then has nothing to refresh
  with. The callback rejects a response with no refresh token rather than
  storing a connection that cannot survive the hour.
- **The `state` parameter is signed, single-use and bound to the user id**
  (`lib/googleAds/oauthState.ts`). Without it the callback is a CSRF primitive:
  an attacker completes consent with their own ad account, gets a victim to load
  the callback URL, and every campaign the victim launches afterwards spends
  against the attacker's account.
- **Refresh tokens are AES-256-GCM encrypted at rest** (`lib/crypto.ts`). This
  column is the only one in the database with that treatment, because it is the
  only one whose leak is useful to an attacker entirely outside our systems — a
  stale backup or a stray `pg_dump` is individually sufficient.
- **Campaigns are created PAUSED**, always. AdVault hands over a fully-built,
  geotargeted, budgeted campaign; enabling it is the advertiser's decision in
  their own account.


## API version

`GOOGLE_ADS_API_VERSION` is pinned to `v26` in `lib/googleAds/env.ts`. Google
retires versions on a fixed schedule (monthly releases since 2026, ~12 months of
support each). Floating it would let response shapes change underneath us.

⚠️ **It was pinned to `v18` from the scaffold until 2026-10-24, and v18 sunset on
2025-08-20** — every Google Ads call this app could make had been dead for over a
year. Nothing noticed, because no launch had ever reached Google: the
`google_ads_not_configured` 503 (waiting on a developer token that Google had
since stopped issuing) masked it completely. **An expired pin here is not
deferred maintenance, it is a silent total outage of the only feature that
spends money.** Check the
[sunset schedule](https://developers.google.com/google-ads/api/docs/sunset-dates)
whenever this file or `env.ts` is touched.

When bumping, re-check the whole surface this app uses:
`customers:listAccessibleCustomers`, `googleAds:search`,
`campaignBudgets:mutate`, `campaigns:mutate`, `campaignCriteria:mutate`,
`geoTargetConstants:suggest`, `assets:mutate`, `adGroups:mutate` and
`adGroupAds:mutate`.

## How a creative becomes an ad

Built 2026-10-24. The chain is five links and **four of them look like success
on their own**:

```
rendered MP4  ->  YouTube video id  ->  Asset  ->  AdGroup  ->  AdGroupAd
   (R2)          (lib/youtube/*,       (YOUTUBE_   (type is    (videoAd)
                  its own queue)        VIDEO)     immutable)
```

Before this, `POST /campaigns/:id/launch` stopped after the campaign and its geo
targeting. It created a budget, a campaign and location criteria, returned 200,
set `campaigns.status = 'live'` — and left a campaign with **no ad group and no
ad**, which can never show anything to anybody. The same failure shape as the v1
missing fonts: a green path with a broken product at the end of it.

Things in that chain worth knowing before changing it:

- **A video ad references an 11-character YouTube video id, never an MP4 URL.**
  The upload is therefore not an optimisation, it is a prerequisite. See
  `infra/youtube-setup.md` for the channel credential.
- **The ad group's `type` is IMMUTABLE at Google** and must match the creative's
  length (bumper ≤6s, non-skippable ≤15s, skippable beyond). `videoAdFormatFor()`
  derives it from the real rendered duration; it is the one piece of pure logic
  here and it is unit-tested.
- **`VideoResponsiveAdInfo` is deliberately not used.** It requires
  `business_name` *and* `logo_images` at ≥128x128 and 1:1. `assets.kind` has a
  'logo' value but it is optional and unvalidated, so using the responsive format
  would make a square logo a mandatory onboarding step and fail launches for
  everyone already signed up without one. `VideoAdInfo` (bumper / in-stream)
  needs the video and nothing else.
- **The ad group and the ad are created ENABLED inside a PAUSED campaign.** The
  campaign is the single serving gate and it belongs to the advertiser. Pausing
  the ad group too would mean enabling the campaign still showed nothing, which
  is the confusing failure this whole chain exists to remove.
- **`counts.liveCampaignsWithoutAds` in `/metrics` should be 0 forever.** It
  counts live campaigns with no attached ad — i.e. the bug above, recurring.

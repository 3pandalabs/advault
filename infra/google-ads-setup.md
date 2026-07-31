# Google Ads — OAuth client and developer token

**Start this first.** The developer token is a manual review that can take days,
and it is the only thing standing between a working AdVault and a launching
AdVault. Everything else — signup, uploads, script generation, rendering,
downloads — works without any of it.

## What you need, and what each part unlocks

| Credential | Unlocks | How long |
|---|---|---|
| OAuth client id + secret | Connecting an account, listing accessible customers | Minutes |
| Developer token (Basic access) | Creating campaigns — i.e. launching | **Days** (manual review) |
| Manager (MCC) account | Prerequisite for applying for the token | Same day |

`isOAuthConfigured()` and `isGoogleAdsConfigured()` in
`api/src/lib/googleAds/env.ts` are separate for exactly this reason: with only
the OAuth pair set, the Connect button works and launching answers a specific
`google_ads_not_configured` 503 that the dashboard renders as "not switched on
yet" rather than as a bug.

## 1. Manager (MCC) account

Create one at [ads.google.com/home/tools/manager-accounts](https://ads.google.com/home/tools/manager-accounts)
under **3pandalabs@gmail.com**, per the org's account convention (org-owned
account, brand email). Note its customer id — digits only, no dashes. That is
`GOOGLE_ADS_LOGIN_CUSTOMER_ID`.

## 2. Developer token — apply immediately

Manager account → Tools → API Center → apply.

- **Test access** is granted immediately but only works against *test* accounts.
  Google rejects mutate operations against a production account with a test
  token and vice versa — which is why `ad_accounts.is_test_account` is recorded
  at connect time, so that mismatch surfaces as a clear message instead of a
  confusing permissions error.
- **Basic access** is the manual review. You need it to touch real accounts.

Submit the Basic access application on day one.

## 3. Google Cloud OAuth client

[console.cloud.google.com](https://console.cloud.google.com) → new project →
APIs & Services:

1. Enable the **Google Ads API**.
2. OAuth consent screen — External. Add the scope
   `https://www.googleapis.com/auth/adwords`. This is the only Google Ads scope
   there is; it is all-or-nothing per account, which is why the Settings page
   says so in plain words rather than implying a narrower permission.
3. Credentials → Create OAuth client ID → **Web application**.
4. Authorised redirect URIs — **both**, exactly:

```
https://advault.3pandalabs.com/oauth/google/callback
http://localhost:3000/oauth/google/callback
```

**Google compares the entire redirect string** — scheme, host, port, path,
trailing slash. The API derives it from `WEB_ORIGIN` (`redirectUri()` in
`lib/googleAds/env.ts`) so the two cannot drift, but the values above must
appear verbatim in the console or the callback fails with `redirect_uri_mismatch`.

While the consent screen is in **Testing**, only accounts on its test-user list
can complete the flow. Add your own before smoke testing, or publish it.

## 4. Set the env vars

On `advault-api` only — the renderer never talks to Google:

```
GOOGLE_ADS_CLIENT_ID=<client id>.apps.googleusercontent.com
GOOGLE_ADS_CLIENT_SECRET=<client secret>
GOOGLE_ADS_DEVELOPER_TOKEN=<from API Center>
GOOGLE_ADS_LOGIN_CUSTOMER_ID=<MCC customer id, digits only>
```

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

`GOOGLE_ADS_API_VERSION` is pinned to `v18` in `lib/googleAds/env.ts`. Google
retires versions on a fixed schedule (roughly quarterly releases, ~12 months of
support). Floating it would let response shapes change underneath us. When
bumping, re-check `customers:listAccessibleCustomers`, `googleAds:search`,
`campaignBudgets:mutate`, `campaigns:mutate`, `campaignCriteria:mutate` and
`geoTargetConstants:suggest` — those six are the whole surface this app uses.

## Known gap: creatives are not attached to the campaign yet

`POST /campaigns/:id/launch` creates the budget, the campaign and its geo
targeting. It does **not** attach the rendered videos as ads, because a Google
Ads video ad references a **YouTube video id**, not an arbitrary MP4 URL — so
the MP4 has to be uploaded to YouTube via the YouTube Data API first, under the
advertiser's own channel, with its own OAuth scope and consent.

`creatives.youtube_video_id` exists for that. Until it is built, the advertiser
downloads the MP4 from the dashboard and uploads it to their channel manually,
then attaches it to the paused campaign in Google Ads. Say this in the UI when
the flow is wired up — right now the launch response's `note` field covers the
paused-campaign half of it.

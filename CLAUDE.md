# AdVault — repo conventions

Self-serve hyper-local YouTube & Shorts ad engine for small local businesses
(plumbers, dentists, restaurants, agents). A business uploads a few storefront
photos, picks zip codes and a daily budget, and AdVault generates 16:9 pre-roll
and 9:16 Shorts creatives and launches a geotargeted Google Ads campaign.

Fifth 3PandaLabs product, after RentVault (`3pandalabs/nrighar`), ReceiptCash,
RsvpVault (`3pandalabs/evitevault`) and MealMargin.

## Naming

**AdVault** in all user-facing copy; "AdVault by 3PandaLabs" where the full
attribution is wanted. Every internal identifier is lowercase `advault` and
there is deliberately no copy/identifier split here — unlike RentVault and
RsvpVault, the name was decided before anything was provisioned, so the repo,
the `advault` database, the `advault_app` role, the R2 buckets, the Coolify
resources (`advault-api`, `advault-renderer`), the hostnames and the
`app: "advault"` key in `api/src/routes/metrics.ts` all agree.

Keep it that way. Renaming any one of those breaks DNS, backups, the admin
dashboard and the Coolify wiring at once.

## Monorepo layout

`web/` (Next.js on Cloudflare Workers) · `api/` (Fastify on Coolify/Hetzner) ·
`android/` · `infra/` (runbooks). Same shape as `3pandalabs/evitevault`. No
React Native `app/`: `android/` (2026-11-13) is a Bubblewrap **Trusted Web
Activity** wrapping the web app for Google Play (`com.threepandalabs.advault`;
build, signing and listing in `infra/play-store/README.md`), so web deploys
update the Android app instantly. Keep `web/src/app/manifest.ts`,
`android/twa-manifest.json` + `android/app/build.gradle`, and the fingerprints
in `web/src/app/.well-known/assetlinks.json/route.ts` in step. Every page must
work at 360px wide, and phone features go through the browser (file inputs,
`capture` for the camera), never native code.

**Account deletion** (Settings → Delete account, `POST /auth/me/delete`) is
required by Play. It anonymises the user row (`deleted_at`,
`deleted+<id>@advault.invalid`) instead of deleting it, because the financial
records cascade from it. See `api/ROUTES.md` "Account deletion". A new table
holding personal data must be handled there too.

Brand assets (`logo/`, `background/`, `footer/`, `attribution/`) are copied
from `3pandalabs/brand` into `web/src/components/`, not referenced at runtime —
same copy-not-import convention as the other apps.

## Android app: payments on the website only (TODO: revisit Play alternative billing at 10%)

**Temporary, owner decision 2026-11-26 (US-only Play launch).** Google Play's
US rules make taking Stripe payments inside the app, or linking out to a
payment page, need a Google program and a ~10% fee. So inside the Android app
(the TWA above) there is **no way to start a payment and no link to one**;
people pay on the website in a normal browser. Code: `web/src/lib/appPayments.ts`
(pure, tested by `node scripts/app-payments-check.mjs` in `web/`) and
`web/src/components/AppPayments.tsx`; every spot is marked `TODO(play-billing)`.

- **Detection** (`detectAndroidApp`): `document.referrer` starts with
  `android-app://com.threepandalabs.advault`, or `?source=twa`
  (`android/twa-manifest.json` startUrl + shortcut, and `build.gradle`; needs a
  new app build), or display-mode standalone AND an Android user agent. A yes
  is remembered in sessionStorage (`advault.inAndroidApp`, try/catch) because
  in-app navigation loses the referrer; the root layout's `AppContextRecorder`
  records it on the first page. Don't add `?source=twa` to `web/src/app/manifest.ts`
  (browser installs).
- **Central guard** in `api()` (`lib/api/browser.ts`): in the app, a POST that
  only ever starts a checkout (`PAYMENT_ROUTES`: `/wallet/topup`,
  `/subscription`, `/campaigns/:id/website/checkout`,
  `/offer-changes/:id/checkout`, `/cinematic/packs`) throws `ApiError 403
  payments_unavailable_in_app` before anything is sent, and every response has
  its `redirectUrl` / `checkoutUrl` nulled (`stripCheckoutLinks`). Calls that
  are only sometimes paid (new-ad order, make a website, confirm an offer
  change, cinematic order with pack credits) stay open so their free case
  works; their buttons are hidden when they would charge.
- **UI**: payment buttons are replaced by `AppPaymentsNotice`, whose text is
  the one constant `APP_PAYMENTS_MESSAGE` (plain text: no link, button or
  address). Use `useInAndroidApp()` / `WebOnlyPayment` for any NEW payment
  button, and add a new checkout-only route to `PAYMENT_ROUTES`. Free actions
  (launch on existing balance, edit, pause/resume, audience, results, stop
  renewing / cancel, "Just this once") keep working.
- Left as is: the Google Ads "Open Google billing" link on onboarding (the
  advertiser's card goes to Google, not to us) and plain-text prices.
- **To undo**: delete the guard lines in `api()`, the `inApp` branches
  (`grep -rn "play-billing" web/src`), the two files above, and the startUrl
  query (or keep it, harmless).

## Git flow

Never commit directly to `main`. Branch → PR → merge, committing as
`3pandalabs-admin` (the conditional gitconfig under `~/Documents` handles the
identity automatically). The initial scaffold PR is the one reasonable
exception to the branch-protection convention; say so when merging it.

`main` must contain `api/` before Coolify is pointed at this repo, or the first
deploy fails on a missing Dockerfile.

## Two containers, one `api/` workspace

This is the first 3PandaLabs app with a **second backend container**:

| Container | Dockerfile | Coolify resource | Entrypoint |
|---|---|---|---|
| API | `api/Dockerfile` | `advault-api` | `dist/index.js`, port 8080 |
| Renderer | `api/Dockerfile.renderer` | `advault-renderer` | `dist/render/worker.js`, no port |

They share one `package.json`, one schema and one build. The renderer image
additionally installs `ffmpeg` (`apk add ffmpeg`) — the API image deliberately
does not, so the API can never be tempted to encode inline.

**Only the API container runs migrations.** Both images would otherwise race
the same `drizzle` bookkeeping table on every deploy. `Dockerfile.renderer`'s
CMD is the worker alone.

**Job claiming is `FOR UPDATE SKIP LOCKED`** (`src/render/jobs.ts`). Do not
"simplify" it to a plain `SELECT ... WHERE status = 'queued'` + `UPDATE`: the
moment a second renderer replica exists, two workers encode the same creative
and the later PUT silently wins.

**`RENDER_CONCURRENCY` defaults to 1 and should stay there.** The shared cx33
has 4 vCPUs and also runs Postgres, three other API containers and the whole
monitoring stack. An unbounded ffmpeg pool is the fastest way to take the box
down for four apps at once.

## /metrics is mandatory

Per the org convention, every app exposes an ops-only `GET /metrics` behind the
shared `METRICS_TOKEN` bearer, and gets a per-app "Usage & resources" table on
admin.3pandalabs.com. `api/src/metrics/collector.ts` + `routes/metrics.ts`
implement it here; the app key is `advault`.

The envelope — `app`, `collectedAt`, `uptimeSeconds`, `counts`, `traffic`,
`process`, `database` — is **shared verbatim across every 3PandaLabs app**, and
`collector.ts` is a byte-for-byte copy of the other apps'. The admin page's
rendering script is fully generic over that shape, so changing it here doesn't
customise this app, it forces a special case into a page that has none. The
`counts` keys are the per-app part and are free to change. When a route or auth
boundary changes, also update this app's Mermaid flow diagram in
`3pandalabs/admin`.

## One 3PandaLabs account (AdVault + SiteVault)

Since 2026-11-16 (migration 0025, `lib/sharedAccount`, `routes/sitevaultAuth.ts`)
**the `users` table is the one account store for AdVault and SiteVault**
(`3pandalabs/sitevault`). The same email + password signs in on both, whichever
app it was created on. SiteVault keeps its own KV account record (sites,
sessions) linked by `advaultUserId`, but the login lives here. Routes:
`api/ROUTES.md` "Internal: SiteVault".

- `users.signup_app`: `advault` (default, every pre-0025 row) or `sitevault`
  (created by SiteVault, `POST /internal/sitevault/accounts`).
- `users.advault_first_used_at`: the first campaign (`POST /campaigns` stamps
  it; 0025 backfilled the earliest campaign).
- `users.sitevault_first_used_at`: the first SiteVault website. Stamped by
  "Make me a website" here, and by SiteVault (`POST /internal/sitevault/usage`)
  when an owner creates or claims a site, and on every SiteVault sign-in of an
  account that has one (self-healing, so older sites get counted too). 0025
  backfilled campaigns AdVault made a site for. Stamps only move earlier.
- **Definitions** (the `account_app_usage` view, the one SQL definition; deleted
  accounts excluded): uses AdVault = `advault_first_used_at IS NOT NULL`; uses
  SiteVault = `sitevault_first_used_at IS NOT NULL`; `app_usage` is
  `advault_only` / `sitevault_only` / `both` / `neither` (signed up, used
  nothing). **SiteVault-only customer = `app_usage = 'sitevault_only'`**: has a
  SiteVault website and has never made an AdVault campaign, whichever app they
  signed up on. Select them with `sitevaultOnlyCustomers(db)` or
  `SELECT email FROM account_app_usage WHERE app_usage = 'sitevault_only';`.
  Don't re-derive the split elsewhere; read the view.
- `/metrics` `counts.accountsSignedUpOn{Advault,Sitevault}`,
  `accountsAdvaultOnly`, `accountsSitevaultOnly`, `accountsUsingBoth`,
  `accountsUsingNeither`. `advertisers` still counts every users row, so it now
  includes SiteVault sign-ups.
- Password policy: `/auth/register` needs 10+; the internal create accepts 8+
  because older SiteVault accounts were made with 8 (new SiteVault sign-ups ask
  for 10), so `/auth/login` checks no minimum. All hashes are bcrypt.
- Account deletion here ends the SiteVault sign-in too (the email is
  anonymised); the SiteVault website is removed separately.
- Tests (`lib/sharedAccount/*.test.ts`, `routes/sitevaultAuth.test.ts`) run on
  PGlite (in-process Postgres, devDependency) with every `drizzle/*.sql`
  applied, including a re-run of 0025 to prove it idempotent. Reuse that
  pattern for anything else that needs a real database.
- Privacy and terms pages on BOTH apps describe the shared account. Change
  them with any change to what it stores.
- **One-tap sign-in between the apps (2026-11-20, migration 0044,
  `lib/signinHandoff`, `routes/signinHandoff.ts`; routes in `api/ROUTES.md`
  "Auth").** A signed-in person follows a link to the other app and arrives
  signed in to the same account. Same shape as the editor/create handoffs:
  HMAC with `SITEVAULT_INTERNAL_TOKEN`, 60 s, single use, bound to uid +
  email, but its own MAC prefix `3pl-signin-v1.` AND a `purpose`
  (`signin-advault` / `signin-sitevault`), so no editor/create token and no
  token for the other direction can sign anyone in. SiteVault -> here:
  SiteVault's signed-in "Video ads" / "Make a YouTube ad" go to its
  `/go/advault`, which 302s to the web page `/auth/handoff?t=&to=`
  (`web/src/app/auth/handoff`, `referrer: no-referrer`); the page POSTs the
  token to `/auth/handoff`, stores the normal token pair (`issueTokens`, the
  login path) and goes to `to` (relative paths only, `lib/safeNext.ts`;
  default /dashboard). Any refusal or an older API = `/login?next=<to>`
  (login honours a safe `next`). Here -> SiteVault: `components/SiteVaultLink.tsx`
  (used by "Edit it on SiteVault") opens the tab at once, asks
  `POST /auth/sitevault-handoff` for a one-time link, and falls back to the
  plain SiteVault URL (signed out, admin, older API, unconfigured). Admins
  are refused on both sides (real `users.role`), test customers can't be
  entered from SiteVault (as `/auth/login` refuses them) but go TO SiteVault
  by id. The nonce table holds no user id (nothing for account deletion).
  Tests: `routes/signinHandoff.test.ts` (PGlite). **Deploy advault-api and
  advault-web before SiteVault** (its links would otherwise land on a
  missing `/auth/handoff` page).

## Google Ads OAuth tokens are the most sensitive thing in this database

A stored Google Ads refresh token authorises **spending someone else's money**.
Treat it accordingly:

- Refresh tokens are encrypted at rest with AES-256-GCM
  (`src/lib/crypto.ts`, key from `TOKEN_ENCRYPTION_KEY`). The column holds
  ciphertext, never a usable token, so a database dump alone does not hand the
  reader an advertising account.
- **Never return a token, or any part of one, from an API route.** `ad_accounts`
  responses are shaped by `toPublicAdAccount()` in `routes/adAccounts.ts`;
  extend that rather than hand-rolling a response.
- The OAuth `state` parameter is a signed, single-use, 10-minute value tied to
  the user id (`src/lib/googleAds/oauthState.ts`, shared by the YouTube flow).
  Without it the callback is a CSRF primitive that attaches an attacker's ad
  account — or YouTube channel — to a victim's login.
- **Launch requires a plan that covers now** (`ensurePlanForRunning` in
  `lib/planBilling`; 402 `plan_required {firstMonthIncluded}` / `plan_pending`
  / `plan_has_no_ads`). Admins and at_cost accounts are exempt. Until
  2026-11-11 launch never checked, so anyone could run ads without paying the
  fee. Since 2026-11-19 the first plan is a $0 Stripe trial (see "The plan
  follows the running ad").
- `campaigns.status` only reaches `live` through `POST /campaigns/:id/launch`,
  which is the single place that CREATES spend. The only other Google mutates
  are status flips of an existing campaign (spend sync, offer expiry, top-up
  resume, and since 2026-11-19 the customer's own `/pause` / `/resume`,
  `routes/campaignRunState.ts`), targeting edits, and since 2026-11-21 the
  offer-change sweep's AD-level mutates inside an existing ad group (add a
  new ad, pause / enable / remove an ad; `lib/offerSwap/sweep.ts`), which
  never touch the campaign, its budget or targeting. Keep it that way.

## A rendered MP4 is not an ad — the chain is five links

A Google Ads video ad references an **11-character YouTube video id**, never an
MP4 URL. So producing an ad is:

```
rendered MP4  ->  YouTube video id  ->  Asset  ->  AdGroup  ->  AdGroupAd
   (R2)          (lib/youtube/*, its   (YOUTUBE_  (Demand Gen, (demandGen
                  own queue)            VIDEO)    YouTube only) VideoResponsiveAd)
```

**The campaign is DEMAND_GEN, never VIDEO. The Google Ads API cannot create
Video campaigns at all** — it can only read and report on them
(`MUTATE_NOT_ALLOWED`, trigger `"VIDEO"`). Until 2026-11-02 this app built a
VIDEO / `VIDEO_REACH_TARGET_FREQUENCY` campaign, so every launch it could ever
make was impossible; nothing noticed because no earlier test got past a missing
credential to reach Google. Demand Gen is what Google points API users to, and
with the ad group's channel controls limited to YouTube in-stream, in-feed and
Shorts it is the same product.

**Launch is ONE atomic `googleAds:mutate`** (`lib/googleAds/demandGen.ts`):
budget, campaign, ad group, location criteria, assets and the ad, linked by
temporary negative ids. Google applies all of it or none of it, so a failed
launch leaves nothing in the advertiser's account. The previous five-call chain
orphaned a budget on every failure. Don't split it back up.

- **A square logo is mandatory.** `logo_images` is required on every Demand Gen
  video ad (1:1, ≥128x128). The campaign page fits whatever the advertiser
  uploads onto a white 512x512 PNG in the browser, and launch checks the latest
  `assets.kind = 'logo'` with `lib/imageSize.ts` before any Google call
  (`logo_required` / `logo_invalid`).
- **Location targeting lives on the ad group** for Demand Gen, not the campaign.
  The one exception is **real estate** (US housing ads, `lib/audience/policy.ts`):
  Google forbids ZIP, age, gender and parental-status targeting for housing,
  so it targets a `proximity` radius around the listing address. Proximity only
  exists as a *campaign* criterion, so those campaigns are created with
  `upgradedTargeting: false` and carry location + language on the campaign.
  The housing rules are checked on save, at launch, and in the builder.
- **Audience filters are optional and default to everyone.** Demographics go
  through ONE `Audience` resource on the ad group (`useAudienceGrouped`), not
  individual age/gender criteria. Every filter shrinks reach for the same
  budget, and the UI says so whenever one is set.
- **Audience edits after launch (2026-11-20, migration 0036).**
  `PUT /campaigns/:id/targeting` (`routes/targeting.ts`,
  `lib/googleAds/targeting.ts`) changes a launched campaign's filters AT
  GOOGLE first, in one atomic mutate, then the row; PATCH refuses
  `audienceFilters` once a Google campaign exists. It reads the ad group's
  Audience/language criteria from Google (rows launched before 0036 have no
  stored Audience), then updates the Audience's `dimensions`, or creates and
  attaches one, or removes the criterion (everyone); languages are diffed at
  the ad group or, for proximity/housing launches, the campaign. Housing rules
  are enforced on the route and in the builder. Validated 2026-11-20 with
  validateOnly against the test customer: an Audience criterion on a Demand
  Gen ad group created without `use_audience_grouped` is accepted, and the
  update/remove shapes parse. The wizard's filters stay parked
  (`AUDIENCE_FILTERS_ENABLED = false`), but the campaign page shows "Who
  should see it" for every launched campaign.
- **Ad schedule (2026-11-20, migration 0037, `lib/schedule/policy.ts`).**
  `campaigns.ad_schedule` = `{days, startHour, endHour}` (one window for the
  chosen days, no overnight), NULL = every day, all day. Launch sends one
  `CampaignCriterion.adSchedule` per day (minute ZERO); the same targeting
  route changes it on a launched campaign (unchanged days kept). Hours are the
  AD ACCOUNT's time zone (America/New_York for US accounts we create,
  Asia/Kolkata for India), and the campaign page's "When it shows" card says
  so. Google accepted AdSchedule on a DEMAND_GEN campaign (upgraded targeting
  on and off) in validateOnly mutates against the test customer, 2026-11-20.
  Since the per-category work (also 2026-11-20) a schedule may carry up to
  two `extraWindows` (own days + hours each, no overlap on a day; Google
  allows 6 a day) for a restaurant's lunch AND dinner or weekday evenings +
  all weekend. Launch and the targeting route send every window per day. Not
  yet proven with a validateOnly mutate: run a dry run with a two-window
  schedule before relying on it.
- **Location targeting is PRESENCE only** (`geoTargetTypeSetting` on the campaign).
  Google defaults to presence-or-interest, which also serves people elsewhere who
  merely search about the area. A walk-in shop pays for those views, and the
  brand ad promises *local* views.
- **Ad text is derived, not asked for.** `buildAdCopy()` takes the script's hook
  and body plus the business fields, fitted to Google's limits (business name
  25, headline 40, long headline 90, description 90) — Google rejects
  over-length text rather than truncating it.
- **Manager (MCC) accounts are refused** at connect
  (`manager_account_not_supported`) and again at launch (`manager_account`).
  They can hold no campaigns, and the org's own MCC was the first thing ever
  connected as an "advertiser account".
- **`validateOnly: true` on the launch body is a dry run**: Google checks every
  operation against the real account and creates nothing. Use it before the
  first real launch into a new account.
- **The daily budget floor is Google's: $5/day in USD** (Demand Gen per-day
  minimum, `minDailyBudgetMinorFor` in `lib/pricing`; INR ₹100). It was cut to
  $1 on 2026-11-10 and a dry run on 2026-11-19 got
  `BUDGET_BELOW_PER_DAY_MINIMUM`: every $1–$4.99 campaign could be paid for
  and never launch. Create/PATCH refuse below it, launch pre-checks it (409
  `budget_below_minimum`, dry run included) and maps Google's error to the
  same code; the launch card lets an unlaunched campaign raise its budget.
  Don't lower it without a dry run proving Google accepts the new figure.
- **Run length (2026-11-18, migration 0033).** The wizard asks "How long
  should your ad run?": 1 week / 2 weeks / Always on, showing the total
  (daily x 7 / x 14 / about x 30.4 a month; `adSpendTotalMinor` in
  `lib/pricing`, mirrored in `web/src/lib/budget.ts`). Stored as
  `campaigns.run_days` (7, 14 or NULL = always on, CHECK constraint),
  changeable until launch. Launch sends Google `endDateTime` (Campaign
  `end_date_time`, "yyyy-MM-dd 23:59:59", account time zone; the date-only
  `end_date` was removed in v23) = UTC today + run_days - 1 and stores it in
  `campaigns.ends_on`, so Google stops the campaign by itself. Our `status`
  stays `live` after Google ends it. Keep it on the UTC date: for a US
  account that is the same day or a day later, so a run is never cut short.
  Copy sells "From $5 a day — Google's minimum"; Keep it running suggests
  $35 (one week at $5/day).
- **Top-up first (2026-11-19, migration 0034).** The run-length picker is now
  behind "Advanced: stop on a date"; the default is always on (`run_days`
  NULL). The wizard, campaign page and wallet page lead with "Add to your ad
  budget" ($35 / $50 / $100 / custom, min $35; enforced server side too since 2026-11-20, 400 `topup_below_minimum` on the requested amount) and "Your $50 lasts
  about 10 days at $5 a day" (`daysOfBudget` in `lib/wallet/runway.ts`,
  mirrored in `web/src/lib/budget.ts`). The wizard only remembers the amount
  (sessionStorage); the campaign page's budget card charges it. The ad runs
  until the budget runs out: `spendSync` pauses it, and a top-up **resumes**
  it (`lib/billing/resume.ts`, from the payment webhook and the hourly sync;
  only campaigns with `paused_for_funds_at`, only when the balance covers
  MIN_FUNDED_DAYS). Before this nothing ever re-enabled a funds-paused
  campaign. Low balance (under max(2 days of budget, $10)) shows a banner on
  the dashboard and campaign page, computed live by `GET /wallet` `budget`;
  the sync also pings ops via ntfy once per episode
  (`campaigns.low_balance_alerted_at`, cleared when healthy), and since
  2026-11-26 emails the customer at the same moment ("Customer emails"). FAQ + terms: unused ad budget stays in the account and is
  refunded if they leave (terms §5, delete-account already refunds it).
  Under the picker, ONE line for the chosen amount (owner): "Your ad would be
  shown about X–Y times to people in your area." (`timesShownEstimate` =
  `estimateReach()` impressions, rounded to 500 — never call them views or
  people; no days or clicks there). "Lasts about N days" stays on the budget
  card / wallet page, from the real balance.

**Four of those five links look like success on their own.** Until 2026-10-24
`POST /campaigns/:id/launch` stopped after the campaign and its geo targeting:
it created a budget, a campaign and location criteria, returned 200, set
`campaigns.status = 'live'`, and left a campaign with no ad group and no ad,
which can never show anything to anybody. Same shape as the v1 missing fonts —
a green path with a broken product at the end of it.

- **The upload is its own queue** (`youtube_upload_jobs`, worker in
  `render/youtubeUploads.ts`), not a step inside the render job, because it must
  stay retryable long after its render finished — an advertiser who connects
  their own channel in month three wants the back catalogue published without
  re-encoding anything. It runs in the renderer (already long-lived) but
  **outside `RENDER_CONCURRENCY`**: an upload is network-bound and must not hold
  the box's only ffmpeg slot.
- **Two channel shapes, and the default is the important one.** No row in
  `youtube_channels` means the ad publishes to the org's channel, which is the
  only thing that works for a managed Option A advertiser — a local shop with no
  YouTube channel must never be asked to make one mid-signup. The advertiser's
  own channel is an upgrade in Settings, never a funnel step. Do not "simplify"
  by deleting the org path.
- **Every published aspect ratio goes into the one ad.** Google serves the 9:16
  cut on Shorts and the 16:9 one in-stream; each creative's
  `google_ad_resource_name` points at that shared ad.
- **The ad group and ad are ENABLED inside a PAUSED campaign.** The campaign is
  the single serving gate and it belongs to the advertiser; pausing the ad group
  too would mean enabling the campaign still showed nothing.
- **A published creative is never re-published.** The worker skips a creative
  that already has a video id, and the edit/retry routes refuse one with a
  `google_ad_resource_name` (`creative_is_live`). A live ad points at a specific
  video asset, so a second upload would leave the ad showing the old cut with
  nothing recording the swap. "Change my offer" (2026-11-21) keeps this: a
  change is always NEW creatives (`creatives.offer_change_id`) in a NEW ad,
  recorded in `offer_changes`; no old creative is re-uploaded or edited.
- **"Ready" in the UI means ready to run, not rendered.** The campaign page's
  badge and its launch gating both require `youtubeVideoId`. Collapsing them
  back into `renderStatus` is how a Launch button got offered for a campaign
  that would be created with no ad in it.

`counts.renderedNotOnYouTube` and `counts.liveCampaignsWithoutAds` in `/metrics`
exist to make this visible; the second should be **0 forever**.

## Ad performance analytics are a read-only report copy

`render/adMetricsSync.ts` (renderer, hourly, outside `RENDER_CONCURRENCY`)
runs ONE `googleAds:search` per ad account for the last 7 days and overwrites
`campaign_daily_metrics` (campaign, date) rows — Google restates recent days.
It covers every launched campaign whoever pays, which is why it is a sibling of
`spendSync` (platform-billed only, moves wallet money) rather than part of it.
It must never call a mutate endpoint. Routes (`/campaigns/:id/metrics`,
`/admin/metrics`) read the table, never Google.

- **Views are `metrics.video_trueview_views`.** `metrics.video_views`,
  `video_view_rate` and `average_cpv` were removed in v22; selecting one 400s
  the whole query.
- **Rates are computed from summed counts** (`lib/adMetrics/policy.ts`), never
  selected from Google — per-day averages cannot be summed across a range.
- **The results screen (2026-11-19, migration 0035).** The campaign page's
  "How your ad is doing" (`results-card.tsx`, `GET /campaigns/:id/results`)
  replaced the 7-day Performance card: cost per view as the hero with cost
  per click beside it (each with a plain "What's this?" and the sum in words),
  views / clicks / times shown / spent / budget left / days left at the
  current pace, two sparklines, and who / where / when breakdowns. The sweep
  stores those in `campaign_segment_metrics` (campaign, date, dimension,
  segment), one read-only search per dimension (`lib/adMetrics/segments.ts`):
  `age_range_view`, `gender_view`, `segments.device`,
  `segments.ad_network_type`, `segments.hour`, and `user_location_view`
  `segments.geo_target_postal_code` / `geo_target_city` (names via
  `geo_target_constant`). Day of week comes from the daily rows. Every field
  name was accepted by Google on 2026-11-19 (read-only queries against the
  test customer); result shapes are from the REST reference. Breakdowns run
  every 3 hours (`AD_SEGMENTS_SYNC_INTERVAL_MS`), not hourly, to spare the
  Basic-access daily operation cap; a campaign with no rows is backfilled
  from launch (max 90 days). An empty breakdown is `null` = "Not enough views
  yet", never zeros. Demand Gen targets demographics via an Audience, not
  age/gender criteria, so age/gender may stay empty for our campaigns.
- **Smart suggestions (2026-11-20, `lib/adMetrics/suggestions.ts`, pure).**
  The results response carries up to 2 cards like "35–44 get you clicks at
  $0.60 vs $1.10 average. Focus on them?" whose button sends the card's
  `apply` body to `PUT /campaigns/:id/targeting` (age/gender via the
  Audience, weekdays/weekends or a morning/afternoon/evening block via the ad
  schedule), always with "At $5 a day, narrowing can make your ad show less.
  If views drop, widen it again." Conservative (`SUGGESTION_RULES`): campaign
  >= 200 shown and >= 10 clicks (else cost per view, >= 40 views); segment
  >= 100 shown and >= 5 clicks (or >= 20 views); segment cost <= 70% of the
  average and < 90% of spend; never Unknown, never a dimension already
  narrowed, never age/gender for real estate. Age narrowing keeps Google's
  unknown-age group. Device is not suggested (no device targeting here).
- **Dashboard list (2026-11-20).** Each launched campaign card on
  `/dashboard` (`app/dashboard/campaign-card.tsx`) shows times shown / views /
  clicks / spent (and, for ads landing on our own site, visits) since launch from ONE `GET /campaigns/stats` call (same
  table, `ownerCampaignStats`), "Waiting for Google's first numbers" before
  any row, and action buttons (Open campaign / Change audience / Top up budget) that deep-link into the campaign page's own
  editors: `?edit=audience#audience` (opens "Who should see it"; offered by
  the same rule the page uses) and `#ad-budget` (only when `walletPays`;
  not-launched campaigns go to the Balance page). The campaign page scrolls
  to its hash once the data has loaded. The cost simulator moved from a fold
  on the list to the header's "What it costs" tab (`/dashboard/costs`); the
  empty state and the public home page keep theirs.
- `/admin/metrics` takes an admin session or the optional
  `ADMIN_ANALYTICS_TOKEN`, never the shared `METRICS_TOKEN`: it names
  businesses and their spend, which `/metrics` deliberately never does.
- **Ad click tracking (2026-11-21, migration 0045, `lib/siteVisits`,
  `lib/googleAds/utm.ts`).** A test ad was shown 180 times with 1 click and
  0 sign-ups, and nothing said what the clicker did. Every NEW launch's final
  URL gets `utm_source=youtube&utm_medium=paid_video&utm_campaign=<campaign
  id>` (`withAdUtm`: appended as text before any `#fragment`, existing
  params kept byte for byte, a tag already present never duplicated). Live
  ads keep the URL they launched with. On advault.3pandalabs.com the root
  layout's `AdVisitTracker` (`web/src/lib/adAttribution.ts`) POSTs a uuid
  `utm_campaign` once per browser session to the public `POST /track/visit`
  and keeps the id in localStorage 30 days (never a cookie); signup sends it
  as `adCampaignId` -> `users.signup_campaign_id`. `campaign_site_visits` is
  a counter per (campaign, UTC day, pathname): no IP, no user agent, no
  visitor id; the IP is only an in-memory rate-limit key (30/hour), plus
  2,000 visits per campaign per day. Unknown ids: 204, nothing stored.
  `/admin/metrics` carries `siteVisits` + `signups` per campaign and per
  currency total. The dashboard card shows "Visits to your website from this
  ad" ONLY when the landing URL is on advault.3pandalabs.com
  (`ownerCampaignStats` `siteVisits`, null otherwise): a customer's own site
  or a SiteVault site is invisible to us, so never show 0 for those. Not
  attributed: accounts created on SiteVault (`POST /internal/sitevault/accounts`).
  Privacy page describes it. Tests: `routes/siteVisits.test.ts` (PGlite),
  `lib/googleAds/utm.test.ts`, `lib/siteVisits/policy.test.ts`.

## Uploaded videos: behind a human review (admins only for launch)

**Paused for customers (2026-11-16):** "Use my own video" is hidden for
non-admins in the wizard and on the campaign page, and the upload POST routes
answer 403 `own_video_paused` unless the user is an admin or
`OWN_VIDEO_UPLOADS=on` is set on advault-api. Customers see "Already have a
video ad? Email 3pandas@3pandalabs.com". Reason: every upload needs a human
review and skips the paid $10 ad. Re-open by setting the env var and dropping
the `isAdmin` gates in `campaigns/new/page.tsx` and `[campaignId]/page.tsx`.
Everything below still applies to admin uploads.

`routes/uploads.ts` lets **any user** attach a finished MP4 to **their own**
campaign as a `kind = 'upload'` creative ("Use my own video"). It is inserted
`ready` only after a HEAD proves the object is in R2 and skips the renderer.
Customers get 6–60s (admins 5–180s), ≤200 MB, 9:16 or 16:9, ≥720p, and must
tick the rights attestation ("…including the music. No copyrighted music.");
who and when is stored on the creative. Uploads are always flagged as synthetic
media on YouTube. Edit and re-render refuse them (`creative_is_upload`).

**Every customer upload is reviewed by an AdVault admin before anything else
happens to it** (`creatives.review_status`: NULL for generated creatives,
`pending_review` → `approved | rejected`; rules in `lib/uploads/review.ts`):

- **Approval is what publishes it to YouTube.** An unreviewed video must never
  reach the org channel — that is where a copyright strike would land. The
  publish/backfill routes refuse or skip unapproved uploads and the YouTube
  worker re-checks as a backstop. Don't enqueue an upload anywhere else.
- **Launch refuses** `video_pending_review` while any upload is pending and
  `video_rejected` when only rejected uploads remain; rejected ones are left out.
- The queue is `/dashboard/admin/reviews` (`/admin/video-reviews`, admin
  session or `ADMIN_ANALYTICS_TOKEN`), and a new upload pings ops via ntfy.
- An admin's own upload is approved on insert.
- **One video is enough (2026-11-16, `lib/uploads/otherFormat.ts`):** when an
  upload is approved, AdVault queues the OTHER shape (16:9 <-> 9:16) as a
  `kind = 'upload'` creative, `renderStatus` queued, source = the upload's
  `video_key`, `render_info.engine = 'reformat'`, already approved (same
  footage). The renderer (`render/reformat.ts`) makes it with ffmpeg only:
  the video sharp in the middle over a blurred, darkened copy of itself. No
  vendor, $0. Skipped when the campaign already has an upload in that shape.
  The campaign page labels it "Made from your video".
- **Both shapes (2026-11-19):** the owner may also upload their OWN video in
  the other shape (web: admins and internal accounts only; since 2026-11-20
  both slots show up front, side by side, "Vertical 9:16 (Shorts)" and
  "Widescreen 16:9 (YouTube)" (optional: we make it from the other), one per
  shape not yet uploaded by the owner, and the wizard takes an optional second
  file in the other shape). Under each uploaded video the campaign page shows
  the review state (approved / waiting / rejected with the reason); a
  "Made from your video" copy shows its source's state. One own upload
  per shape: the same shape again is 409 `already_uploaded`. The owner's file
  REPLACES the reformat copy in that shape (`shapeUploadPlan` in
  `reformatPolicy.ts`; copy row deleted, its render job cascades, R2 files
  removed via `lib/uploads/remove.ts`), under the campaign row lock that
  `queueOtherFormat` also takes, so a copy and an own upload never coexist in
  one shape. A copy deleted mid-render: `completeJob` returns false and the
  worker deletes what it wrote and never enqueues YouTube. `queueOtherFormat`
  never copies into a shape the owner uploaded (any review state). Same review
  rules for the second upload (admin approved on insert, others pending).
  Removing an own upload also removes the copies made from it, and removing
  one of two own videos re-queues the copy for that shape. Launch puts every
  ready approved upload in the one ad, so there is exactly one video per shape.
- No automated scanning. Google Video Intelligence explicit-content detection
  (~5¢/video) is the noted future option; it would not replace the human check.

Google reviews the ad again after launch: `adMetricsSync` also reads
`ad_group_ad.policy_summary` (read-only) into `campaigns.google_ad_*`, shown on
the campaign page as "Google: Approved / Under review / Disapproved".

## Real estate: listing/open-house ads, agent ads and "just sold" ads

A real-estate campaign picks one (2026-11-13, `campaigns.realty`, `lib/realty`;
"just sold" added 2026-11-20: a home the agent sold, same facts, no open
house, the ad wins neighbors' listings and never invites anyone to buy it).
**An open-house listing ad stops by itself** (2026-11-20): launch sends
Google the open-house day as the end date (the earlier of that and the run
length) and refuses with 409 `open_house_over` once it has passed (UTC).
The original two kinds:
a **listing** ad (one home: the street, price, beds/baths and an optional open
house day/time go to the script writer, and from there into the hook,
voiceover and sticker) or an **agent** ad (the agent and their city, no home).
The facts are the advertiser's own, so they may appear in the ad. The script
prompt carries a **Fair Housing Act** rule: describe the property, never who
it suits (no families, age, religion, "safe", "exclusive"…). Keep it when
editing `script/prompt.ts`. `fallback.ts` builds both kinds without the model.

## Two render engines: the template ad, and the ffmpeg layout behind it

Since 2026-11-13 the renderer can make the **template ad**, the look of the
home-page demos (offer sticker, word-by-word captions, end card), with
Remotion's headless Chrome: `api/remotion/` (own package, README there) driven
by `src/render/template.ts`. It is on when `RENDER_ENGINE=template` on
`advault-renderer`. **Any template failure falls back to the old ffmpeg
layout** (`render/ffmpeg.ts`), so the template can never cost a customer their
ad; keep that fallback. The renderer image is Debian for Chrome (glibc), not
Alpine.

- The script's optional `sticker` (`badge`, `headline`, `tagline`,
  `benefits`) feeds the sticker. Same rule as all copy: a price or discount
  only if the advertiser wrote one (`script/prompt.ts`).
- Voice: `VOICE_PROVIDER=fal` + `FAL_KEY` is ElevenLabs v3 through fal (the
  demo voice, `FAL_VOICE`, default Sarah). A fal failure falls back to edge-tts
  (`synthesizeVoice`), never to silence. One voiceover per ad, not per format: every format of a generation shares the first script's `voiceoverText` and `sticker` (`lib/creatives/generate.ts`), and the worker caches a paid voice in R2 at `campaigns/<id>/voice/<hash>.mp3` keyed by provider, voice and text, so the second format and redos with unchanged narration reuse it. Scripts start with an audio tag
  ("[warmly] …"), stripped for edge-tts.
- Motion: `MOTION_PROVIDER=fal` is Kling through fal (`kling/v4/flash/image-to-video`, the demo motion) with one fixed motion prompt, so one clip per source photo is cached in R2 (`campaigns/<id>/clips/`) and shared by both formats. The direct Kling account (`KLING_API_KEY`) has been out of credits since 2026-10 (code 1102): with it every ad silently became Ken Burns stills. Each render records what it used in `creatives.render_info` (`GET /admin/recent-renders`).
- **Demo look (2026-11-14)**: the script writer (Claude) is sent the photos (presigned URLs; retried blind if that fails) and returns a `voice` (one of `AD_VOICES`, `script/schema.ts`) and one `photoMotions` line per photo, shared by both formats so one clip per photo is still paid once (the clip cache key includes the motion line). `PHOTO_ENHANCE=fal` on the renderer turns on the demo "pro photo" pass (`render/enhance.ts`, fal `meta/muse-image/edit`, cached at `campaigns/<id>/pro/`); the agent portrait is never edited, and any failure keeps the original. `FAL_VOICE`, when set, pins every ad to one voice. The web app shrinks photos to 2048 px before upload (Claude refuses images over 5 MB).
- **Mixed ad (2026-11-14)**: two renderer switches, both off by default. `FAL_MOTION_ENDPOINT=google/gemini-omni-flash/v1.2/image-to-video` makes the photo clips with Gemini Omni instead of Kling (~70% cheaper per second, judged as good on the demos); Omni only makes 9:16 or 16:9, so a clip belongs to one format and is cached per format (`motionIsPerFormat`). `AD_OPENER=fal` adds a 5 s Omni text-to-video **opening shot** per format from the script's `openerPrompt` (mood only, filtered by the cinematic `rejectVisualPrompt`; an unsafe one is dropped, `cleanOpener`), played sharp under the offer sticker for 4 s; every real photo then goes to the reel. Cached at `campaigns/<id>/opener/`. Any opener failure means no opener, never a failed ad. Omni clips carry generated audio; the template plays every clip `muted`, keep it that way.
- **Omni straight from Google (2026-11-15)**: `lib/ai/google/omni.ts` calls the same Gemini Omni model through Vertex AI (Interactions API, `global`, inline MP4) so Google credits (Cloud trial, startup program) pay for footage. `OMNI_PROVIDERS=vertex,fal` + `GOOGLE_SA_KEY_B64` (service-account JSON key, base64; role Vertex AI User) on the renderer puts Google first for motion clips, the opener and cinematic shots; ANY Google error falls back to fal. This is the DEFAULT order (unset = `vertex,fal`): at 720p Google is cheaper (~$0.0695/s vs fal's $0.0819/s; fal's $0.0273/s is its 360p price), and credits can pay it. `OMNI_PROVIDERS=fal` forces fal only. The token is signed with node:crypto (no google-auth-library).
- **fal is prepaid and critical**: when it runs dry ads silently lose motion, the photo pass and the voice. `render/falBalanceWatch.ts` reads the balance hourly (needs `FAL_BILLING_KEY`, a fal key with billing read access; `FAL_KEY` cannot) into `vendor_balance_snapshots` and pages ntfy below a **dynamic** line: 7 days of the last 14 days' average spend, min $5 (`lib/vendors/balancePolicy.ts`, tested). Any fal call failing for lack of balance pages at once (`noteFalFailure`). Shown on `/dashboard/admin/business`.
- **The website is optional (2026-11-15, migration 0021).** `campaigns.landing_url` is nullable; a business with no website can make ads (the end card and YouTube description just omit it). Launch refuses with 409 `landing_url_required`, because Demand Gen needs a final URL; the campaign page `website-card.tsx` lets them add one (PATCH `landingUrl`) or points them to SiteVault (sitevault.3pandalabs.com) for a free site. **One-click (2026-11-15):** "Make me a website" on that card calls `POST /campaigns/:id/website` (`routes/website.ts`): it asks for phone, town, optional hours and an ownership tick, sends those plus name, category (`sitevaultCategory`), the offer cleaned of links (`offerBanner`) and up to 6 ad photos (the polished `proPhotoKey` copy when present), and the services list and one-liner built from the ad's offer sticker (`servicesFromSticker` / `taglineFromSticker`; area/licence chips skipped) (SiteVault shrinks photos to web size itself). **The ad video is NOT sent here (2026-11-16, migration 0026, `lib/siteVideo`)**: it goes on the site at LAUNCH ("Also show this ad on my website", ticked by default, SiteVault sites only), as the reason to launch. Launch sets `site_video_wanted` and pushes the newest ready generated cut (16:9 first, ≤40 MB) to SiteVault `POST /api/internal/sites/<slug>/video`, fire-and-forget, with an API sweep (10 min, 5 attempts). Once on, it stays, even if the plan stops or the ad is paused. SiteVault shows it as "See us in action". The site itself is made by SiteVault `POST /api/internal/sites` (bearer `SITEVAULT_INTERNAL_TOKEN` on advault-api = the Worker's `INTERNAL_TOKEN`), then sets `landing_url` and stores the edit link encrypted in `sitevault_edit_enc` (migration 0022; read back via `GET /campaigns/:id/website`). Privacy page lists SiteVault. **Addresses (2026-11-15):** the make form has a "Your web address" field (`<slug>.3pandasite.com`, suggested from the business name, checked live against SiteVault's public `GET /api/address`), sent as `slug`. Owners can rename on SiteVault's edit page (old address 301s); `GET /campaigns/:id/website` follows it via SiteVault `GET /api/internal/resolve` (`slugFromSiteUrl` also maps old `/s/<slug>` links) and rewrites `landing_url` before launch only. **One website per business (2026-11-15):** one SiteVault site per AdVault account. `POST /campaigns/:id/website` refuses with 409 `website_exists_for_account` when another campaign of the account has one; `GET /campaigns/:id/website` returns `accountSite` and the card offers "Use my website" (`POST /campaigns/:id/website/use-existing` copies the link, resolved to the current address, and the encrypted edit link). SiteVault also refuses a second live site for the same phone. **Sites built ON SiteVault (2026-11-16):** the shared account may own a site made on SiteVault itself; `accountSite()` falls back to SiteVault `GET /api/internal/account-site?advaultUserId=&email=` (`fetchAccountSitevaultSite`, 8 s, never throws; down or an older Worker = null = the old behaviour) after the account's own campaigns, so the card shows "Use my website" (no $10 quote) and use-existing links it (409 `account_website_not_live` unless SiteVault says live/grace). SiteVault's internal create also refuses a second site for the account (409 `account_has_site`), mapped here to `website_exists_for_account`, before any checkout. Such a campaign has NO `sitevault_edit_enc` (SiteVault never handed us a key): the card's edit link is SiteVault's key-less `/edit/<slug>` (sign-in, same account); the offer combo is slug-based and works; the launch video does NOT (SiteVault's `/video` takes AdVault-made sites only), so `wantsSiteVideo` needs `advaultMade` (= `sitevault_edit_enc` set) and the launch checkbox / card line hide for them. Tests: `routes/website.test.ts` (PGlite, SiteVault stubbed).
- **Admin "Delete it and make a new one" (2026-11-17).** So admins can re-test "Make me a website" end to end. When the account already has a website (the card's "Use my website" state), a user whose REAL role is admin (`users.role`, test mode on or off; never `customerFlowRole`) also sees "Delete it and make a new one" (two-step confirm; customers see no change). `GET /campaigns/:id/website` then returns `adminCanDelete` (and `adminCanMakeAnother` outside test mode, where admins may still make any number of sites; their `accountSite` now shows too, and may be a made-but-unpaid site on another campaign, `state: "pending"`). `POST /campaigns/:id/website/account-site/delete` (`requireAdmin` + `users.role` re-read) calls SiteVault `DELETE /api/internal/sites/<slug>` (sitevault PR #66: deletes files, record, aliases, phone/name index, account link and stats, freeing the address, phone and the account's one-site slot), then unlinks it here: every NOT launched campaign of the account whose `landing_url` is that site (or an older address resolving to it) loses `landing_url`, `sitevault_edit_enc` and the `site_video_*` state; one whose `sitevault_pending_url` is it loses that and `sitevault_edit_enc`; unpublished `website` purchases and unpushed site offers for those slugs are capped at max attempts (`site_deleted_by_admin`) so no sweep pushes to an address a new site may reuse. Refused (nothing deleted) while a LAUNCHED campaign links the site (409 `website_in_use_by_launched_campaign`), if the site isn't the one the card showed (409 `account_website_changed`), and on SiteVault's 409s (`website_has_subscription`, `website_not_your_site`). The one-per-account rule is unchanged: a test-mode admin still gets 409 `website_exists_for_account` until the delete frees the slot, then the full make form with the normal $0.50 checkout; a real admin outside test mode stays free.
- **"Your website" inside AdVault (2026-11-19, `/dashboard/website`, `routes/websiteEditor.ts`).** AdVault-made sites are edited HERE, never by sending the customer to sitevault.3pandalabs.com: the page frames SiteVault's own editor (`/edit/<slug>?embed=1`: no SiteVault chrome, billing or upsell; only `https://advault.3pandalabs.com` may frame it). `GET /website/editor` mints a 60 s, single-use handoff (`lib/sitevault/editorHandoff.ts`, HMAC with `SITEVAULT_INTERNAL_TOKEN`, bound to the user id, email and slug) that SiteVault's `/embed/session` checks before setting its normal session cookie. The iframe grows to SiteVault's `sitevault:height` message (origin- and source-checked). A site built ON SiteVault gets a link to SiteVault's editor instead (its billing lives there). The website card's edit links and the dashboard's empty-state link point at this page. Deploy SiteVault first (sitevault PR "Embed the edit page in AdVault"). **The same editor opens inline on the campaign page** (`components/SiteEditorFrame.tsx`, shared by both): right after "Make me a website" ("Your website is ready. Make it yours…", "Skip for now"), scrolled to SiteVault's "Website style" picker via its `sitevault:sections` message (falls back to scrolling to the frame), and from the card's "Edit my website" button. A $10-fee site opens it only after payment: checkout returns with `?website=paid`, the card polls until the site is published and `landing_url` is set, then opens it and drops the param. Never open it for a pending (unpaid) site.
- **"Make me a website" = SiteVault's FULL builder (2026-11-19).** The website card's "Make me a website" no longer shows the short form: it frames SiteVault's builder (every option) in AdVault create mode, pre-filled from the campaign, BEFORE the site exists. `POST /campaigns/:id/website/builder` (same refusals as the quick create, shared `newWebsiteRefusal`) POSTs the pre-fill to SiteVault as a draft, server to server (`createSitevaultDraft`; photos are in our private R2 and too big for a URL), and returns a 60 s single-use create link (`createHandoffUrl`, MAC prefix `sv-embed-create-v1.` + `purpose: "create"`, so edit and create tokens can't be swapped) naming only the draft id. The frame (`SiteEditorFrame`, generalised with `onCreated`/`title`) posts `sitevault:created`; the card checks origin and source, then `POST /campaigns/:id/website/builder/created` reads the draft back from SiteVault (bound to this user and campaign) before recording it with the quick create's own post-create steps (`recordNewSite`: paid = pending URL + $10 checkout and the `?website=paid` return; free = `landing_url`). The short form stays only as a fallback: "Use the quick form instead", and automatically when the builder can't open (`website_builder_unavailable`: an older/down SiteVault). **Test customers get the builder too (2026-11-19):** their `*.invalid` email is never sent (draft `ownerEmail` omitted, create and edit tokens `email: ""`), and SiteVault links them by user id only (`acctadv:<id>`, an id-only account that can never match a real email; sitevault "AdVault test customers: id-only accounts"). The "Your website" editor handoff does the same. Test mode is unchanged ($0.50 fee, pending + checkout). Deploy SiteVault first (sitevault PR "AdVault create mode"). Tests: `routes/websiteBuilder.test.ts`.
- **$10 website fee (2026-11-15, migration 0024, `lib/websiteFee`).** For advertisers who pay per ad (`paysPerAd`; admins/at_cost stay free and publish at once), "Make me a website" creates the SiteVault site with `awaitingPayment=1` (unpublished), stores it in `campaigns.sitevault_pending_url` (NOT `landing_url`), and sends them to a $10 Stripe checkout (`sku = website`, `us-website`, first year of SiteVault Pro included, then $49/yr on SiteVault). The shared purchase webhook marks it paid and fires `publishPaidWebsite` (SiteVault `POST /api/internal/sites/<slug>/paid`, `ref` = purchase id, idempotent); only on success does the site become `landing_url` (never overwriting a link the owner typed meanwhile) and the purchase `delivered`. The API sweep retries every 10 minutes, up to 5 attempts. `POST /campaigns/:id/website/checkout` re-opens checkout for an abandoned payment; `GET /campaigns/:id/website` returns `pendingSite` / `websiteFee`. Launch needs `landing_url`, so an unpaid site blocks launch by itself.
- **Offer combo (2026-11-15, migration 0023, `lib/siteOffer`).** Buying a $10 new ad for a campaign whose link is a SiteVault site (and that has offer text) shows "Also put this offer on my website": +$2 (`SITE_OFFER_ADDON` in `lib/pricing`, US only, a second Stripe line item, so $12 total), or "uses 1 of your N website credits" ($10 total) when SiteVault billing is on and the site has a credit, or "(free)" when SiteVault billing is off. Always PAID here; SiteVault only applies it. The mode is decided server-side at checkout from SiteVault `GET /api/internal/sites/<slug>/offer-status` (pure `siteOfferQuote` in `policy.ts`, tested); unreachable SiteVault, a paused/unpublished site or no offer text hides or refuses the option (`site_offer_unavailable`), never a guess. Recorded on the purchase (`site_offer_mode/text/slug/pushed_at/error/attempts`). After payment the webhook fires the push (`POST /api/internal/sites/<slug>/offer`, `payment` advault for paid/free, credit for credit, `ref` = purchase id, idempotent on SiteVault's side) without awaiting it: **a SiteVault failure must never fail or delay the ad purchase.** The API (only it holds the token) sweeps every 10 minutes and retries up to 5 attempts. Admins / at_cost get it free via `POST /campaigns/:id/site-offer` (a $0 `sku = 'site_offer'` row). Deep link from SiteVault's edit page: `/dashboard?siteOffer=<slug>` opens the matching campaign with the box ticked. The website card shows "Offer on your website: updated / pending / couldn't update — we'll retry".
- **Before & after (2026-11-17, migration 0029, `lib/beforeAfter`).** Trades only (`beforeAfterAllowed`: the wizard's Plumbing/Electrical/HVAC/Landscaping/Auto repair/Car wash/Cleaning presets, plus typed-in trades like roofing, painting, remodeling, pressure washing, detailing, flooring, junk removal; NEVER health, dental, cosmetic, salon, spa, fitness or anything body-related, because Google restricts before/after for personal health & cosmetic results; not food, retail or real estate). Browser mirror `web/src/lib/beforeAfter.ts`, kept word for word by a test. Up to 2 pairs on `campaigns.before_after` `[{beforeAssetId, afterAssetId}]` + `before_after_attested_at/by` ("These are real photos of our own work.", required), set by `PUT /campaigns/:id/before-after` from the wizard's photo step or the campaign page's card (changes affect the NEXT ad made, never the current one). **Honesty rule in code:** `generateForCampaign` keeps pair photos OUT of `sourceAssetKeys` and puts their R2 keys on `script.beforeAfter` (never trusted from a script edit), so they never get the photo pass or motion; the renderer also skips any pair key that is in `sourceAssetKeys` (`plainPhotoIndexes`). Both halves get the same plain treatment. The template shows each pair full screen after the opener, 3.5 s: BEFORE, a left-to-right wipe, AFTER (whole photo over a blurred copy, no zoom); the ffmpeg fallback shows BEFORE then AFTER stills, labelled, after scene 1. The script writer is told the pairs exist and may say "from this… to this", never specifics. "Make me a website" sends them (original photos) to SiteVault as files `ba1Before`/`ba1After`/`ba2Before`/`ba2After` (sitevault PR #61); an older SiteVault Worker would not store them, so deploy SiteVault first.
- The end card shows the landing page's domain, never a phone number we
  weren't given for the purpose.

## Per-category features (2026-11-20, `lib/categories`)

Each business category gets its own extras through SHARED mechanisms that a
per-category table configures, never one-off features. `categoryKey()`
(`lib/categories/key.ts`) maps the wizard's ten presets and typed-in
("Other") categories to `plumbing | electrical | hvac | dentistry |
restaurant | landscaping | auto | cleaning | realEstate` (null = no extras).
Every module is pure and tested, and its `// <shared>` block is mirrored word
for word in `web/src/lib/categories/` (`mirror.test.ts` fails otherwise; edit
the API copy, then the web copy).

- **Seasonal calendar** (`seasons.ts`): per category, peak seasons with a
  suggested offer and call to action (US-only ones marked, e.g. snow, frozen
  pipes, dental benefits; real estate only for agent ads). The campaign
  page's `season-card.tsx` shows when a season starts within 21 days (5 for
  the monthly month-end move-out), else the running one; "Use this offer"
  opens the text for editing, and saving calls `PUT /campaigns/:id/offer`
  (`routes/campaignOffer.ts`). **That route never touches Google or
  re-renders**: a live ad keeps what it launched with, the next ad made uses
  the new offer. It exists because PATCH refuses a live campaign. "Not now"
  is remembered per browser (localStorage), per season occurrence.
- **Schedule presets** (`schedulePresets.ts`): Plumbing / HVAC / Electrical
  get "24/7 for emergencies" (every day, all day) and "Evenings and weekends"
  (Mon–Fri 5 pm–midnight + all weekend, an extra window); Restaurant gets
  "Lunch and dinner" (11–2 and 5–9 every day) and "Dinner only". A tap only
  fills the "When it shows" editor; the owner saves it. It is wired to Google
  through the existing ad schedule (above).
- **Badges** (`badges.ts`, migration 0039, `routes/badges.ts`, campaign page
  `badges-card.tsx`): per-category trust badges (license number, licensed &
  insured, background-checked, 12-month warranty, ASE certified, licensed
  pesticide applicator, upfront pricing, most insurance accepted, financing,
  24/7 emergency service), max 4, the owner ticks "These are true for my
  business today" (who/when stored). `generateForCampaign` copies the chips
  onto `script.badges` (ONLY attested ones; the script edit route keeps the
  stored ones, like `beforeAfter`) and passes them to the writer as
  `confirmedFacts`; the template shows them as chips on the END CARD. The
  ffmpeg fallback does not show them. NOT on the SiteVault website: its
  internal API has no field for them (would need a SiteVault change).
- **Plan offer builder** (`planOffer.ts`, `components/PlanOfferBuilder.tsx`):
  Landscaping, Cleaning, HVAC. Price per visit / month / season + optional
  first-visit deal (% off, amount off, free) -> "Weekly mowing from $35 a
  visit. First visit 50% off." It only fills the offer box (wizard and the
  campaign page's "Your offer" card, `offer-card.tsx`); nothing is stored.
- **Claim checks** (rules now in `lib/compliance/claimRules.ts`, re-exported
  by `claims.ts`; `components/ClaimWarnings.tsx`): warnings
  with the reason as the owner types (dentistry: painless / best dentist /
  guarantees; lawn: 100% pet-safe / non-toxic / guaranteed green; any
  category: 0% or no-interest financing without terms, #1 / the best,
  guarantees). **Only a housing exclusion in a real-estate ad ("adults only",
  "no kids", "no section 8") is BLOCKED** (Google housing policy + Fair
  Housing Act): POST/PATCH `/campaigns` and `PUT /campaigns/:id/offer` answer
  400 `claim_not_allowed`. Real estate's targeting limits are unchanged
  (`lib/audience/policy.ts`).
- **Category extras** (`extras.ts`, migration 0040 `campaigns.category_extras`,
  `routes/categoryExtras.ts`, campaign page `extras-card.tsx`):
  Restaurant = a featured dish (name, price, one of their photos: it LEADS the
  next ad, `withSpotlightPhoto`) + an order/reserve link (a button sets it as
  the ad's link before launch); Auto repair = the makes they service;
  Landscaping = existing-customer ZIPs ("Show my ad in these ZIP codes" PATCHes
  `targetZipCodes`, before launch only: there is no post-launch ZIP edit at
  Google yet) + "Neighbor price" offer copy. Dish and makes reach the writer
  as `confirmedFacts` and the end card as `script.endCardLine` (set by
  `generateForCampaign`, kept by the script edit route). Electrical upgrade
  presets (EV charger, panel, generator, solar hookup) and Cleaning's
  move-out / move-in are one-tap offers (`OFFER_PRESETS`,
  `components/OfferPresetButtons.tsx`) in the wizard and "Your offer" card.
- **Asked BEFORE the first ad (2026-11-20).** Until then badges and extras
  were only on the campaign page, after the ad was made, so the first ad
  never used them. The wizard's last step ("Extras", photo path only) now
  has an optional "Make your ad stronger" card: badges + attestation
  (`components/BadgePicker.tsx`) for every category with badges, and the
  category's extras (`components/CategoryExtrasFields.tsx`: dish from the
  chosen photos + order link with "Send people from my ad to this link",
  ticked when no website was given; makes; customer ZIPs with "Also show my
  ad in these ZIP codes", ADDED to step 1's ZIPs, + neighbor price into the
  offer). Before & after stays on the photo step; open house stays on
  step 1; electrical/cleaning presets stay in the offer box. All of it goes
  IN `POST /campaigns` (`badges`, `categoryExtras`, `beforeAfter`), checked
  by the same `checkBadges` / `checkCategoryExtras` / `checkBeforeAfter` the
  PUT routes use, so it is on the row before generate or the paid order
  reads it (`routes/campaignCreateExtras.test.ts` proves the first script
  gets badges, end-card line, dish photo first and before/after). Keep these
  fields out of `campaignFields` (PATCH would skip the attestation). The
  campaign page moved Offer / Badges / Extras / Before & after into one
  `<details>` at the bottom, "For your next ad: offer, badges, photos",
  open when there is no ad yet (no creative, or all failed). SeasonCard
  stays near the top.

## Client attestation & compliance (2026-11-20, migration 0043, `lib/compliance`)

The client is responsible for what their ad says; this is how we can show
they said it. Routes and codes: `api/ROUTES.md` "Client attestation &
compliance". Owner to-do: the /terms note and /content-policy are marked
pending legal review; a lawyer must review them.

- **Two ticks, every time** (`components/AttestationChecks.tsx`, sentences from
  `lib/compliance/texts.ts`, mirrored word for word in `web/src/lib/compliance/`,
  `lib/compliance/mirror.test.ts`): "I confirm all information and claims in
  this ad are true, accurate, and lawful, and I accept responsibility for
  them." + "I own or have rights to all photos/media uploaded, and have
  consent from any person shown." In the wizard before create, and on the
  campaign page before a new-ad order, generate-again/redo, an upload and
  launch. The API (`passComplianceGate`) refuses without them, admins
  included. **Changing a sentence means a new `ATTESTATION_VERSION`**, never an
  edit in place: every row stores version AND exact text.
- **`ad_attestations` and `terms_acceptances` are append-only**: app code only
  inserts; a trigger (`advault_append_only`) refuses UPDATE, DELETE and
  TRUNCATE except an UPDATE that only blanks `ip_address`/`user_agent`, which
  account deletion does. No foreign keys on purpose: rows outlive the campaign
  (owners can delete campaigns) and users are anonymised, never deleted. Don't
  add an FK with an ON DELETE action: the trigger would refuse it. IP is
  `cf-connecting-ip`, else Fastify's `req.ip` (trustProxy).
- **Terms**: `TERMS_VERSION` (api + web mirror) must match the effective date
  on /terms. Bump it when the terms change and every user meets the blocking
  "We've updated our Terms" screen in the dashboard layout; order / generate /
  launch answer 409 `terms_not_accepted` meanwhile. Signup has an explicit
  checkbox (no more browsewrap).
- **One claim table, three severities** (`claimRules.ts`): `block` (housing
  exclusion, 400 `claim_not_allowed`, unchanged), `warn` (unchanged list), and
  `review` (health cures/miracle/weight-loss numbers, finance/crypto/returns/
  payday/no credit check, "guaranteed results"). Review phrases found in the
  campaign text OR the generated script set `compliance_status = needs_review`
  (`reevaluateCompliance`, on create, PATCH, PUT offer, generation, script
  edit). The ad can still be made; launch answers 409 `needs_review`; an admin
  approves at `/dashboard/admin/reports` ("Wording waiting for review"). An
  approval is per (rule, phrase): unchanged text stays approved, a NEW phrase
  re-flags. The campaign page shows a banner with the phrase and why.
- **Takedown** (`lib/compliance/takedown.ts`, admin `/dashboard/admin/reports`):
  `compliance_status = taken_down` (+ who/when/why, funds-paused marker
  cleared), Google pause through the existing status flip (managed accounts;
  otherwise an URGENT ops alert to pause by hand), YouTube videos set private
  via `videos.update` (`setVideoPrivate`). **The org channel token was minted
  with `youtube.upload` + `youtube.readonly` only, so until it is re-minted
  with the `youtube` scope that step fails and ops are told to do it by hand.**
  Every path that makes, launches or switches an ad back on refuses or skips a
  taken-down ad: launch, resume, generate, redo, order, paid-order generate,
  script edit, retry, upload, the top-up / plan resume (`resumeFundedCampaigns`,
  `resumeAfterTopUp`, `hasAdWaitingForBudget`), the budget respread, the render
  worker (fails the job, no retry, so `reclaimStalled` can't revive it) and the
  YouTube worker. **Not done: removing the launch video from the customer's
  SiteVault website** (follow-up; the ops alert says to do it by hand).
- **Report this ad**: every campaign has an unguessable `public_id`; newly
  published YouTube videos end their description with "Report this ad:
  https://advault.3pandalabs.com/report?ad=<public id>". The public page posts
  to `POST /reports` (5 per IP per hour, ntfy ping). A taken-down ad's page says
  "This ad has been removed."; an unknown id says it couldn't be found.
- **The script writer only repeats the client** (`script/prompt.ts`): no
  invented statistics, numbers, testimonials, quotes, reviews, awards,
  rankings or superlatives. `creatives.generation_inputs` stores the writer's
  exact input (business fields, offer, confirmed facts, photo R2 keys, prompt
  version `AD_SCRIPT_PROMPT_VERSION`; never presigned URLs), fallback path
  included. Bump the prompt version when the prompt changes.
- `requireAuth` / `requireAdmin` now `return reply` after a 401/403 (Fastify
  already stopped the handler on `reply.sent`; a test proves it either way).
- Privacy page lists the IP / user agent capture and retention; /terms keeps
  its text with a "Pending legal review" note; `/content-policy` is a DRAFT.
- Tests: `routes/compliance.test.ts` (PGlite: ticks on every action and the
  audit row, append-only trigger, account deletion, terms gate, review ->
  launch 409 -> approve -> re-flag, takedown and every refusal, reports + rate
  limit, requireAdmin, India), `lib/compliance/policy.test.ts`.

## Google Ads API access: developer tokens are gone, and the version pin is load-bearing

**Developer tokens were sunset on 9 Sep 2026.** API access level is now a
property of the **Google Cloud project** that issued the OAuth credentials,
gated on brand verification plus active paid billing. The header is still
accepted and ignored, and will be rejected in 2027.
`googleAdsEnv.developerToken` is optional and deliberately **not** part of
`isGoogleAdsConfigured()` — requiring it made every launch answer 503 waiting on
a credential Google no longer issues.

A consequence worth knowing: the process cannot interrogate its project's access
level, so **a project without Basic access fails at the first mutate call**, not
at a predicate. There is no clean "not switched on yet" for that case.

`GOOGLE_ADS_API_VERSION` was pinned to `v18` from the scaffold until 2026-10-24.
**v18 sunset on 2025-08-20** — every Google Ads call this app could make had been
dead for over a year, and nothing noticed because the 503 above meant no launch
ever reached Google. An expired pin here is not deferred maintenance, it is a
silent total outage of the only feature that spends money. Check the
[sunset schedule](https://developers.google.com/google-ads/api/docs/sunset-dates)
whenever `lib/googleAds/env.ts` is touched.

## `is_managed` and `billing_mode` are two different questions

`ad_accounts.is_managed` — did AdVault provision this account under the MCC?
`ad_accounts.billing_mode` — whose card does Google actually charge?

They are independent, and the original schema conflated them. That made the
genuinely useful third shape — an MCC child the advertiser pays for themselves —
impossible to express, and left `spendSync` and the wallet guard keyed on the
wrong column. Three combinations are real:

| `is_managed` | `billing_mode` | Shape |
|---|---|---|
| false | customer | Advertiser connected their own Google Ads account |
| true | platform | MCC child, **org fronts the spend** — the only case the wallet exists for |
| true | customer | MCC child, advertiser's own card |

`platform` + `is_managed = false` is impossible and a CHECK constraint says so.

**Anything asking "is the org's money at risk" must read `billing_mode`, never
`is_managed`.** Both `routes/launch.ts` and `render/spendSync.ts` do. Keying
either on `is_managed` would demand a wallet balance from an advertiser whose
card Google already has, and would auto-pause campaigns we never funded.

**There is no Google Ads API that adds a payment method.** `BillingSetupService`
only links a payments account that already exists. For `customer`, the
advertiser accepts an account invitation and enters a card in Google's own UI.
For `platform` — the default, where customers never touch Google — a payments
account is only listable from a CHILD account once the MCC has monthly
invoicing, which it doesn't yet. So `lib/billing/managedCard.ts` creates a
per-customer **Mercury virtual debit card**, alerts an operator via ntfy to add
it in Google Ads, and polls until a funded `billing_setup` appears
(`billing_link_status` 'pending' → 'active'; `billing_setup_pending` at launch
until then). Full runbook: `infra/managed-billing.md`.

Either way the only signal is polling for a funded `billing_setup`. Do not add
a "mark as done" control — a self-reported yes produces a campaign that
launches successfully and then silently never serves, which is strictly worse
than an honest blocked state.

Platform specifics worth not undoing:

- **Platform campaigns launch ENABLED.** The customer has no Google access, so
  a paused campaign is one nobody could ever switch on. Their Launch press is
  the go-ahead; the wallet guard has already required funds. Customer-billed
  and BYO launches stay PAUSED.
- **Platform accounts are USD** (US payments profile, USD Mercury cards), and
  launch refuses a campaign whose currency differs from the account's
  (`currency_mismatch`) — a mismatch silently multiplies or divides spend.
- **The card freeze is a backstop for a FAILED pause only.** After a successful
  pause Google still bills for ads already shown; a declined charge flags the
  account. A top-up unfreezes.
- Mercury's API never returns full card numbers, so the operator copies the
  number from the Mercury app. That step is irreducible, not unfinished.
- **Until the MCC is eligible, the operator also creates the account.** Google
  refuses `CreateCustomerClient` (`CREATION_DENIED_INELIGIBLE_MCC`) until an
  account linked to the MCC has spent over $1,000. The platform path then
  inserts a row with `customer_id` NULL, `provision_status` 'pending' and a
  `provision_ref` like `AV-7K2Q`; the operator creates the account with that
  code in its name and links it, and the renderer sweep matches it
  (`findOperatorAccount`). Automatic creation is always tried first, so this
  disappears by itself once Google allows creation. Don't make `customer_id`
  non-null again without handling these rows.

Which modes a deployment offers is `ADVAULT_BILLING_MODES`. Offering one is a
single-path onboarding; offering both adds the choice step. Removing the choice
should mean removing an env value, not unpicking a fork — keep the branch to the
one discriminator.

`lib/billing/policy.ts` holds every pure decision here and is the only part of
the money path with tests, because it is the only part that needs neither a live
Postgres nor Google Ads API access.

## The subscription is the revenue model — there is no one-off charge

For most of this repo's life AdVault could not earn money at any customer
count. Every plan carried `monthlyFeeMinor: 0`, `applyEntry` was never called
with `type: 'fee'`, and the plan prices on the marketing page were display-only
strings. `lib/pricing` now holds five SKUs and one of them has to be sold:

| Line | India | US |
|---|---|---|
| `offer` — 3 fresh videos/month, **no Google at all** | ₹999/mo | $39/mo |
| `managed` — creatives plus a live campaign | ₹1,499/mo fee | $79/mo fee |
| `evergreen` ("Keep it running") — one ad kept live, $10 per ad, offer CHANGES (1 a month included, $2 after) | not sold | $20/mo fee + chosen monthly ad budget (min $35) |

**Evergreen never enters the ORIGINAL offer loop, but it gets offer CHANGES
(owner decision 2026-11-21).** The original loop (`hasMonthlyOffers`: `offer` and
`managed`) re-renders the creatives and its expiry PAUSES the campaign
(`campaigns.offer_expires_at`, `runOfferExpirySweep`), the opposite of what
Keep it running sells; that stays exactly as it was for those two lines.
Evergreen (`hasOfferChanges(line)`) instead gets "Change my offer"
(`lib/offerSwap`, section "Change my offer" below): a cheap re-cut swapped into
the live ad at Google after approval, and back to the BASE ad on the end date,
never a pause. `POST /offers/current` answers evergreen 409
`plan_uses_offer_changes` `{campaignId}` (was `plan_has_no_offers`). Offer
cycles open for evergreen only when the WhatsApp change loop is on
(`OFFER_SWAP_WHATSAPP` = `on`, or `internal` for internal accounts) and the
owner has a launched campaign. Use
`hasMonthlyOffers` / `hasOfferChanges` rather than comparing line names.

**Every ad is bought one at a time** (`new_ad` purchase, $10 first and
repeat, `lib/newAd` + `routes/newAds.ts`). Since 2026-11-13 this applies to
**every advertiser** (not admins or `at_cost`), plan or no plan: before that,
anyone without a plan got ads made free while we paid the vendors. No free
first ad (`FREE_FIRST_AD_LIMIT = 0`). Generation answers 402 until the campaign
has a paid order; the order saves the wizard's photos and formats, and the
campaign page spends it once the webhook marks it paid. A paid ad includes
`RENDERS_PER_AD` = 3 renders (first + 2 redos, `purchases.renders_used`):
generate-again and script edits spend one; retrying a FAILED render is free and
retry refuses anything that didn't fail. Every render costs vendor money, so
never add a re-render path that skips `newAdGate`. **A customer-uploaded video is free** (decided
2026-11-13): only generation is gated (`newAdGate` in `routes/creatives.ts`);
uploads and launch never ask for a paid order. Keep it that way. It shares the `purchases` table and webhook with
cinematic, so `claimNextPurchase` must keep filtering `sku = 'cinematic'` or the
cinematic worker would try to film a $10 photo ad.

**The offer line is the one that can be sold today.** It needs no Google Ads API
access, no YouTube channel, no ad account and no Indian entity — which is
exactly why it exists. Do not "simplify" it away as a cut-down managed plan.

**Every rupee of platform revenue is a `fee` ledger row**, whichever rail
collected it, so "what did AdVault earn" is one query over one column. Because
the ledger is a wallet and a wallet cannot go negative, `feeFunding()` decides
whether the fee needs a paired `topup` credit alongside it: platform-billed
managed advertisers prepay an all-in amount and the fee is drawn from it;
everyone else is charged externally and gets the paired credit so the balance
nets to zero. Getting that backwards fails an offer-line charge whose card just
succeeded, or hands a platform-billed advertiser free ad budget every month.

**Provider metadata is fixed at mandate creation, so every renewal webhook
carries the FIRST invoice's id — for years.** `resolveInvoiceForPayment()`
treats it as a pointer to the subscription and applies payment to whichever
invoice is open. Removing that indirection breaks month two silently: the
customer keeps being charged and the database stays in month one.

`lib/subscriptions/policy.ts` and `lib/offers/policy.ts` hold every pure
decision and are tested. Anything reaching for `db` or `fetch` belongs in the
sibling `index.ts`.

## The plan follows the running ad (2026-11-19, migration 0038, `lib/planBilling`)

Owner decision, option B (amounts since "$55 a month" below): **"$20 a month
plus your monthly ad budget (from $35) while your ad is running. Pause
anytime: no fee while paused."** and **first month included with the first
ad**, once per account. The customer's first payment is the $10 ad + $35
minimum budget = $45. Copy everywhere is `web/src/components/PlanPriceLines.tsx`
(three lines + "Every dollar of your ad budget goes to Google. AdVault earns
only the $10 and the $20."). Applies to the `evergreen` line only
(`PLAN_FOLLOWS_RUNNING_LINE`); other lines keep the old lifecycle.

- **Running** = live + launched + `ends_on` not past (UTC). No Google call; our
  status stays `live` after Google ends a run_days campaign, so the end date is
  what says "ended".
- **`syncPlanBillingForUser(userId)` is the ONE place the plan moves**
  (idempotent, never throws, per-user in-process queue; the one-live-
  subscription index guards restarts across processes). Nothing running →
  Stripe `cancel_at_period_end=true`; running again inside the paid period →
  `false` (no second charge); running after the period → a new Stripe
  subscription off-session with the previous plan's card (charged now), else
  the customer goes to checkout. Called from launch, pause, resume, the plan
  webhook, the top-up resume, and an API sweep every 10 min. **The renderer
  has no Stripe key**: it only changes campaigns, and its hourly auto-restart
  asks `planAllowsRunningFor` (DB only) before switching an ad back on.
- **Why `cancel_at_period_end`, not `pause_collection`**: it fits the
  existing lifecycle (period = paid, `customer.subscription.deleted` ends it,
  renewal sweep untouched, MRR honest); pause_collection keeps one "active"
  subscription for ever with voided invoices that every reader of
  `subscriptions` would have to learn to discount.
- **First month**: `POST /subscription` for an account with
  `users.plan_first_month_used_at` NULL creates a $0 first invoice and a
  Stripe Checkout trial to the period end (card saved; the first $20 + the monthly ad budget a month
  later only if an ad still runs, else the trial just ends). Paying the $0
  invoice sets `plan_first_month_used_at` once. 0038 backfilled it for every
  account that ever paid a plan invoice. Launch answers 402 `plan_required
  {firstMonthIncluded: true}` and the campaign page shows "Start my plan ($0
  today)", which returns to the campaign (`?subscribed=1`).
- **Test mode / test customers / internal**: admins in test mode get the same
  flow at 50 cents (trial included; off-session restarts use an inline
  50-cent price on the previous product). Test customers launch dry runs
  only, so they never run an ad and never pay a plan. Internal accounts pay
  full price. Admins (not testing) and at_cost: exempt, never synced.
- **MRR / paying subscribers** in `/metrics` skip plans that are stopping
  (`cancel_at_period_end`) or in their included month; those are
  `planStoppingSubscribers` / `planIncludedMonthSubscribers`.
- Fixed with it: Stripe's first payment arrived twice and the second copy
  opened and paid month two (`firstPayment` now makes it a duplicate); the
  evergreen $19 was drawn from a platform customer's ad budget on top of the
  card charge (`feeFunding('evergreen') = external`); account deletion never
  cancelled the Stripe plan; an abandoned plan checkout blocked re-subscribing
  for ever (now replaced).
- Tests: `lib/planBilling/policy.test.ts` (pure),
  `lib/planBilling/planBilling.test.ts` (PGlite: first month, webhook
  duplicate, renewal, stop/un-stop, pause/resume routes, off-session restart,
  decline, test mode, exempt), `lib/subscriptions/providers/stripe.test.ts`.

## "From $55 a month" (2026-11-19, migration 0041)

Owner decision: month one = $10 ad + $10 website + $0 plan (included) + the
chosen ad budget; every month after = $20 plan + the SAME chosen ad budget,
recharged automatically. The customer chooses the monthly ad budget (whole
dollars, min $35: $35 -> $55/month, $100 -> $120/month) and can change it
anytime. The section above still describes the lifecycle; this changes the
amounts.

- **One set of terms for everyone** (`planTerms` in `lib/planBilling/policy.ts`,
  pure, tested): $20 plan + the chosen recharge (`POST /subscription`
  `adBudgetMinor`, default $35; a restart keeps the previous plan's amount).
  Validation: `monthlyAdBudgetProblem` in `lib/pricing`. No grandfathering:
  the $19 plan never had a real customer. Customer-billed ad accounts (Google
  charges their own card) get no recharge. Test mode: both lines at 50 cents
  whatever the chosen amount.
- **Changing it**: `PUT /subscription/ad-budget {amountMinor}`
  (`changeMonthlyAdBudget`): Stripe budget item quantity, `proration_behavior
  =none`, so it applies from the next invoice; then
  `subscriptions.budget_recharge_minor` (the next `openNextInvoice` copies it).
  Test mode: validated, nothing changes.
- **Recharge = a second recurring line on the same Stripe subscription**
  (`stripeSubscriptionLine` / `stripeRestartForm`), quantity = dollars x
  the $1 unit price (`splitStripeItems` tells it from the plan item). One invoice a month, the
  included-month trial covers both, `cancel_at_period_end` stops both, so
  "no fee and no recharge while paused" needs no extra code.
  `subscriptions.budget_recharge_minor` = the current chosen amount;
  `subscription_invoices.budget_minor` per invoice (0 in the included month).
  The `invoice.paid` webhook reads the budget the Stripe invoice actually
  charged from its own lines (`stripeInvoiceBudgetMinor`) and sets it on the
  pending invoice first, so a change made after the invoice was opened is
  credited exactly as charged.
  The webhook expects `amount_minor + budget_minor` (`invoiceChargeMinor`);
  `markInvoicePaid` posts the fee as before and credits `budget_minor` as a
  wallet `topup` with ref `subinv:<invoice>:budget`, once per invoice, then
  `afterPlanBudgetCredit` unfreezes cards and resumes funds-paused ads. MRR
  and revenue still read `amount_minor` only: the budget is never revenue.
- **An ad paused only for funds keeps a recharging plan billing**
  (`adWantsPlan`): the next month refills it and switches it back on. A
  customer pause still stops the plan.
- **Stripe prices**: $20 plan = `STRIPE_PRICE_US_EVERGREEN` (must point at
  a $20 price, not the old $19 one, or the webhook's amount check refuses the
  payment), ad budget = `STRIPE_PRICE_US_AD_BUDGET`, a **$1/month unit
  price** on the "AdVault ad budget" product. Missing ids fall back to
  inline prices (checkout) or the previous subscription's products (restart),
  so nothing breaks before the owner creates them.
- **"Just this once"** (`users.plan_choice` 'once', 0041; `PUT
  /subscription/choice`): same payment today ($10 ad, $10 website, the
  budget as an ordinary top-up), NO Stripe subscription, no plan, no
  recharge; the ad runs until its budget runs out. `planGate` /
  `planAllowsRunning` let a 'once' account run (the wallet gates still
  apply); `planBillingAction` never starts, restarts or un-stops a plan for
  it, only lets a live one run out. The first one-time launch uses up the
  included month (`ensurePlanForRunning`), so switching to Keep it running
  later (`PUT /subscription/choice {monthly}` -> `POST /subscription`)
  charges $20 + the budget that day. **"Stop renewing"** on the subscription
  page is the same choice: 'once' sets `cancel_at_period_end` (the plan
  sync's own stop path) even while an ad runs, and the ad keeps running on
  its budget. 'monthly' inside the paid period takes the stop back (the sync
  un-stops it while an ad runs). The AdVault-made website keeps the old rule
  for one-timers: a year of Pro from the $10. Renewal reminder emails: not
  built (no mailer domain for AdVault).
- **Website included while the plan runs** (`lib/sitePlanCover`): the plan
  sweep asks SiteVault (`POST /api/internal/sites/<slug>/plan-cover`
  `{until, ref}`) to keep the AdVault-made site on Pro until the plan's paid
  period end. Needs that SiteVault route; until it exists pushes 404 and are
  retried every sweep.

### Spreading the budget across the month (option C, migration 0042, `lib/schedule/spread.ts`)

`campaigns.schedule_mode`: `spread` (default for new campaigns) or `custom`
(every campaign before 0042, and any schedule the owner saves). For a
`spread` campaign the wallet pays for, launch picks whole days from the
balance: `round(balance / daily / 4.35)` days a week ($35 at $5 -> 2, $70 ->
3, $150+ -> every day = no schedule), best days per category first
(`SPREAD_DAY_ORDER`: restaurants Fri/Sat, landscaping and real estate
Sat/Sun, dentistry Tue/Thu, others evenly spaced). A top-up or a plan
month's recharge re-picks the days (`respreadForUser`, a schedule edit at
Google; `custom` is never touched). The owner can switch back with
`PUT /campaigns/:id/targeting {scheduleMode: "spread"}` ("When it shows").
**Overspend:** Google may spend 2x daily on a serving day, and with a
schedule it tends to. `spendSync` pauses a SCHEDULED campaign once the
balance is under 2 x the live daily total (`pauseForFunds`), so the wallet
cannot go negative; at exactly $5/day $35 shows 6 days and $5 rolls over, and
at Google's 2x worst case 3 days. Resume still needs 3 days of budget.

## Admin "Test as customer" (2026-11-17, migration 0027, `lib/testMode`)

`users.test_as_customer`, switched by an admin in Settings (`PATCH
/auth/me/test-mode`, 403 for non-admins); a banner shows on every dashboard
page while it is on. An admin with it on is billed EXACTLY like a standard
advertiser and every Stripe charge (ad, website, offer combo, video bundle,
monthly plan) is `TEST_PRICE_MINOR` = 50 cents (`chargeMinor()` in
`lib/pricing`), so the real checkout, webhook and ledger run end to end.
Purchase/invoice rows hold the 50 cents, so webhook amount checks reconcile.
Stripe metadata carries `test_mode=1`; `/metrics` and `/admin/ad-production`
exclude admins' payments from revenue (`/admin/business` already did).
Ad budget top-ups are not test priced (real Google spend).

**Any customer-flow check on `role === "admin"` or `req.userRole` must go
through `lib/testMode`** (`billingIdentity()`, `customerFlowRole(req)`; pure
rules in `policy.ts`, tested), and the web uses `actsAsAdmin(me)` from
`web/src/lib/testMode.ts`. Admin pages and `requireAdmin` keep the REAL role so
the admin can always switch back. `at_cost` customers are unchanged.

**Test customers (2026-11-17, migration 0030, `routes/testCustomers.ts`).** The
admin's own account gets "used up" (one website, one ad account and card, one
plan), so a real admin can create separate customer accounts
(`users.test_owner_id` = the admin) and switch into them: the new-campaign
wizard asks "Who are you testing as?" when the admin is in test mode or inside
one, and a banner offers "Back to admin". Switching issues a normal token pair
for the other user; inside a test customer the access token carries
`testOwner`, re-checked against `test_owner_id` (and the owner's real DB role)
before "back" or a refresh is honoured. A test customer: role advertiser,
`*.invalid` email (Stripe gets no `customer_email`, SiteVault no
`ownerEmail`), random unknown password (login refused), always test mode in
`lib/testMode` ($0.50, tagged), **launch forced to `validateOnly`** (Google
checks, nothing created, $0), and "TEST · " on its Google account, Mercury card
and ops alerts. Ad-account setup really runs (real MCC child + Mercury card):
the owner accepted that. Excluded from revenue and `/admin/business`.

## Internal accounts (2026-11-18, migration 0032)

3PandaLabs runs ads for its own apps (SiteVault, RsvpVault, AdVault…) through
AdVault from org logins such as advault@3pandalabs.com. These are **real,
full-price customers in every flow**: real prices, real Stripe charges, real
launches, NOT test mode. `users.is_internal` (+ optional `internal_label`,
e.g. "SiteVault"), set by a real admin (DB role) via `POST
/admin/internal-accounts` / the "Internal accounts" box on
`/dashboard/admin/users`. What it changes, and nothing else:
- Revenue / traction: excluded wherever admins and test customers are
  (`/metrics` subscriber/MRR/add-on revenue, `/admin/ad-production` `paidAds`,
  `/admin/business` customers, categories and revenue) and reported apart
  (`counts.internal*`, `internalPaidAds`, `/admin/business` `internal`).
  `counts.advertisers` still counts every users row, as before.
- Stripe: `internal=1` + `internal_label` metadata on every checkout session
  (and its payment intent / subscription), from `billingIdentity().internal`
  (`internalStripeMetadata` in `lib/testMode/policy.ts`).
- Names: "INTERNAL · " on the Google Ads child account, the Mercury card and
  ops alerts (`accountLabel`), like "TEST · ".
- `/auth/me` returns `isInternal`/`internalLabel`; the dashboard header shows
  an "Internal · <label>" badge.
- `GET /admin/internal-spend?since=&until=` (admin session or
  `ADMIN_ANALYTICS_TOKEN`, `routes/adminInsights.ts`) gives per internal
  account what it paid AdVault in the range (ad budget top-ups vs fees by
  purpose) and its real Google spend (`campaign_daily_metrics.cost_micros`).
  The org admin site's "Internal" tab reads it and adds the Stripe fees.
Never let it change a price, gate or launch. Tests:
`routes/internalAccounts.test.ts`, `routes/internalSpend.test.ts`.

## Accounts marked as test (2026-11-21, migration 0046)

Some ordinary sign-ups are really ours (the Google Play reviewer's demo
login, our own QA account) and showed up as real customers. They must keep
working exactly like a customer, so they cannot become test customers
(`test_owner_id`: no login, dry-run launches, $0.50 prices).
`users.marked_test`, set by a real admin (DB role) via `POST
/admin/test-accounts {email, test}` / the "Test users" box on
`/dashboard/admin/users`, ONLY keeps the account out of real customers,
revenue and traction: everywhere admins / test customers / internal accounts
are excluded (`/metrics` subscriber/MRR/add-on revenue, `/admin/ad-production`
`paidAds`, `/admin/business` customers, funnel, segments, categories,
revenue and its `internal` list), and `/admin/account-counts` counts it under
`test.markedByAdmin` (an account both internal and marked counts as test only).
It changes NO login, price, gate, test mode, Stripe tag or launch; nothing in
`lib/testMode` reads it. Refused for test customers and admins (409). Never
put a real email in a migration or test to set it (public repo): admins set it
in the UI. Tests: `routes/markedTest.test.ts`, `routes/accountCounts.test.ts`.

## Stripe: one org account, one AdVault endpoint

The 3PandaLabs Stripe account is shared by every app. AdVault tags what it
creates with `metadata.app = advault` and registers ONE webhook,
`/webhooks/stripe`, which routes to the three handlers
(`lib/payments/stripeRouting.ts`) and answers 200 to anything that is not
AdVault's. Stripe gives each endpoint its own signing secret and the app reads
one, so never register the per-purpose URLs separately. Setup:
`infra/stripe-setup.md`.

## The cinematic add-on is TEXT-to-video, and that is the whole point

**Now called the "video bundle", and SALES ARE PAUSED (2026-11-15).** People-facing
name only; routes, SKUs (`cinematic`, `cinematic_pack`), tables and `lib/cinematic`
keep "cinematic". Don't confuse it with the cinematic OPENER shot every $10 ad now
starts with (`render/cinematic.ts`, always on). Anil paused it because the opener
gives every ad the "wow" shot and real photos are what build trust. Off unless the
API env `VIDEO_BUNDLE_SALES=on`: `/add-ons` returns nothing, packs return 410,
new orders return 410 unless the user still has unspent pack credits, and the
dashboard menu item is removed (page still works by URL). Delivery, refunds and the
purchase webhook are untouched. Recheck later before re-enabling or deleting it.

Everything the subscription produces, a shop owner could plausibly make on
their own phone — copy, captions, a slow zoom, even an image-to-video clip.
CapCut and Kling's consumer app do all of it free. We measured the ceiling: a
real Kling image-to-video clip came back **visually indistinguishable from the
free `zoompan` filter**, because image-to-video can only move *within* a photo
it cannot relight.

`lib/cinematic` sells the opposite. The model invents the scene, so it owns the
lighting, the lens and the composition — which is why vendor showreels look the
way they do. That is the part a phone cannot reach at any effort, and it is the
only reason a ₹2,999 one-off price stands up. **Do not "unify" this with the
motion path.** They differ in cost per unit, in failure policy and in what they
are for.

**Three rules that are not style preferences:**

**Generated footage carries atmosphere only; every factual claim lives in a
burnt-in caption or the voiceover.** `rejectVisualPrompt()` enforces it, and it
is enforced in code rather than only in the system prompt because a system
prompt is a request. A generated visual is not evidence: film a glistening
croissant for a shop that sells rusks and the ad has made a claim about goods
they do not sell — misleading advertising under ASCI and the FTC alike, carried
by the advertiser. Video models also render text as garbled characters, and a
wrong price in a paid placement is worse than no price.

**There is always a real photo and it always closes.** An ad made entirely of
generated footage is a stock-footage advertisement for a business that may as
well not exist. `rejectBrief` refuses without one.

**Nothing here falls back.** Every other AI provider in this repo degrades — a
missing key costs polish on a free render. This one is the thing the advertiser
paid for, so `cinematicProvider()` returning null means *refuse the sale*, and a
production failure means `status: 'failed'`, which is a **refund queue**, not a
terminal state. `counts.cinematicFailedUnrefunded` in `/metrics` is the only
number in that envelope that is a work item rather than a statistic. Silently
shipping a Ken Burns slideshow to someone who bought cinematic footage sells
them the thing they specifically chose not to buy.

**Since 2026-11-14 the footage comes from fal** (`CINEMATIC_PROVIDER=fal`, Gemini Omni Flash, `falOmni` in `lib/ai/cinematic`, $0.0819/s at 720p on fal; Google direct ~$0.0695/s goes first): 3 shots x 5 s, generated for **both formats**, rendered with the template ad in `cinematic` mode (full-screen film, sticker, captions, end card, up to 30 s), the brief's ElevenLabs narrator, and the campaign's own photo (portrait, else a people photo; pro-photo pass unless it is a portrait) as the close. A retry reuses the brief and skips formats already made. Admin orders are free (provider `manual`, paid on creation) for testing.

**Pricing (2026-11-14): $29 first, $39 after, or a 3-pack for $99** (`cinematic_pack`, US only). A pack is a purchase that films nothing: it grants 3 credits, and an order paid with one is a `cinematic` purchase with provider `pack` and amount 0, created under a per-user advisory lock (`packCreditsLeft`, `POST /cinematic/packs`). Only paid/producing/delivered pack orders count as spent, so a failed one hands its credit back. The shot plan (brief) is written by the API at order time, before payment; the renderer has no Anthropic key.

Two consequences that look like bugs and are not: the renderer strips vendor
audio (`-an`) and uses our own TTS, because Veo will invent spoken dialogue and
invented speech is the claim problem again through another channel. And shot
durations come from `planShotDurations()` — the price list — never from the
model, or a chatty response would give a fixed-price product a variable vendor
bill.

## Local ads are OFFER ads, and the loop runs on WhatsApp

A shop does not advertise "we exist", it advertises "₹499 haircut till Sunday".
The offer changes monthly, which is what makes a monthly charge obvious to the
customer — they are buying this month's promotion going out, not a video
subscription. `offer_cycles` is one row per subscriber per month tracking that
conversation.

**WhatsApp is the interface, not a notification channel.** Owners will not open
a dashboard on the 1st; they will reply to a message. `/dashboard/offer` is a
deliberate fallback for people who prefer a screen and for when Meta is down —
keep every step of the loop reachable both ways.

Two constraints that are easy to get wrong:

- **The monthly prompt must be a pre-approved TEMPLATE.** It opens the
  conversation, so it falls outside the 24-hour service window and free text
  will not deliver. `sendTemplate` and `sendText` are separate functions so the
  choice is forced at the call site.
- **Reminders are capped at two and then stop.** A shop owner who feels nagged
  reports the number, and enough reports cost the WhatsApp business account —
  the channel, not one customer.

**Nothing is sent unless `WHATSAPP_SENDS=on` (2026-11-21).** The Meta
credentials (`WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`,
`WHATSAPP_VERIFY_TOKEN`) may sit on advault-api/renderer so the webhook verifies
and Meta can be wired, while `whatsAppSendsEnabled()` keeps every send, the
monthly offer-cycle prompts and the offer-change loop inert. The offer-change
loop additionally needs `OFFER_SWAP_WHATSAPP` = `internal` or `on`.
**Hidden in the web UI since 2026-11-22** (`WHATSAPP_UI_ENABLED = false` in
`web/src/lib/whatsappUi.ts`, owner decision): no page asks for a mobile number
or mentions the WhatsApp loop until the owner says it is ready; flip the flag
to bring every surface below back. The API is unchanged.
**Opt-in + modes (2026-11-21, migration 0048):** `users.phone` is E.164
(`lib/phone`), `users.whatsapp_opt_in_at` is the tick "Message me on WhatsApp
about my ads" (signup, Settings, the wizard's last step, the campaign page /
Change my offer card; all `components/WhatsAppOptIn.tsx`). ONE rule for every
outbound, `whatsAppRecipientAllowed` (via `mayMessage` / `offerSwapAllowedFor`
in `lib/offers`): sends on + phone + opt-in + not deleted, and with
`OFFER_SWAP_WHATSAPP=internal` an `is_internal` account. `internal` = the loop
runs, for our own accounts only (monthly cycles too: `contactFor` hides the
phone of anyone else). The web shows "Next time, just WhatsApp your new offer
to <WHATSAPP_PUBLIC_NUMBER>" only when `/auth/me` `whatsapp.enabled`; never
advertise a number that won't answer. Senders match EXACTLY on E.164
(`matchPhone`, legacy no-"+" rows on full digits); unknown / ambiguous senders
get one reply per 24 h. Tests: `lib/offers/whatsappGate.test.ts`. Templates are registered as
`en_US` (`WHATSAPP_TEMPLATE_LANGUAGE`, default `en_US`); the names live in
`WHATSAPP_TEMPLATE_*` env vars and must match approved templates whose
variables match what the code sends — check before turning sends on.

`inferOfferExpiry()` ALWAYS returns a date, falling back to end of month. That
property matters more than the parsing: an offer campaign outliving its deadline
spends the advertiser's budget sending people to a deal the shop will not
honour, and nothing at Google expires an ad for us. The sweep in
`render/offerCycles.ts` pauses them.

## Change my offer (2026-11-21, migration 0047, `lib/offerSwap`)

Owner decisions A-G. Routes: `api/ROUTES.md` "Change my offer". Pure rules
in `lib/offerSwap/policy.ts` (tested); DB in `index.ts`; Google in
`lib/googleAds/adSwap.ts` + the renderer sweep `sweep.ts`
(`render/offerSwaps.ts`, every `OFFER_SWAP_SWEEP_INTERVAL_MS`, default 10 min);
WhatsApp in `whatsapp.ts`. Web: the campaign page's "Change my offer" card
(`change-offer-card.tsx`, `id="change-offer"`, opened by `?edit=offer`), and
the dashboard card's "Change my offer" button + status line.

- **Immediate advance + progress bar (2026-11-22).** The renderer no longer
  waits for the sweep: after every render job (`render/worker.ts`) and every
  YouTube upload job (`render/youtubeUploads.ts`) it calls
  `advanceOfferChangeForCreative`, which runs the SAME per-change step as the
  sweep (`stepChange`) for a change still `rendering` / `publishing`: the
  last cut ready -> `preview` (+ `sendSwapPreview`), the last cut on YouTube
  -> `add_to_google` -> `pending_google`. The sweep stays the backstop.
  Steps are serialised per change in-process (re-read inside the lock) and
  the status moves are conditional on the status they were decided on
  (`moveChange`), so sweep + advance never act twice (a cross-process race
  after an `addAd` pages ops). The GET view carries `mode` and `progress
  {startedAt, expectedSeconds}` (`offerChangeProgress`: 75 s slide (voice-over included) / 240 s
  re-cut from `createdAt`, 120 s publishing from `confirmedAt`, null
  otherwise); the card shows `EstimateProgress` (`render-progress.tsx`,
  `web/src/lib/estimateProgress.ts`), time-based so it survives a refresh,
  holding at 95% with "Almost there, checking…", and polls every 5 s while
  making / publishing. `pending_google` has NO bar (Google can take hours):
  plain "Google is checking… a few hours" text.

- **A change is a cheap RE-CUT, not a new ad.** `queueRecut` copies each
  launched shape's script and photos (the template = launched creatives:
  `offer_change_id` NULL, `google_ad_resource_name` set, kind `standard`) and
  rewrites ONLY hook, captions, end card text, voiceover and sticker
  (`recutScript`: a small Claude edit constrained by a JSON schema, merged by
  `mergeRecut` so scene order / photos / durations, `photoMotions`,
  `openerPrompt`, voice and generate.ts's marks can't change; any failure =
  the deterministic `deterministicRecut`). One voiceover shared by both
  shapes (one TTS call; edge-tts fallback as always). The creatives carry
  `render_info.recut` and the renderer runs **reuse-only**: cached motion
  clips, opener and pro photos only; a cache miss is a Ken Burns still / no
  opener, NEVER a fal or Vertex call. The one exception: the owner's ONE new
  photo may get a motion clip when `OFFER_CHANGE_PHOTO_MOTION=on` (off by
  default). Re-cuts are NOT auto-uploaded to YouTube: they are previews until
  "Put it live". (There is no music track in the template to reuse.) This is
  a deliberate render path outside `newAdGate`: it is gated by the change's
  own price and capped at `MAX_OFFER_PREVIEWS_PER_DAY` (6) per campaign; don't
  add another.
- **Compliance is the same as any offer.** `claimBlock` refuses (400
  `claim_not_allowed`, e.g. housing exclusions); `reevaluateCompliance` runs
  over the new scripts, so a REVIEW phrase sets `needs_review` and confirm
  answers 409 `needs_review` until an admin approves on
  `/dashboard/admin/reports`. Web needs the two ticks (recorded `generate`);
  a WhatsApp YES carries the two sentences in the preview message and is
  recorded as `launch` with `user_agent = 'whatsapp'`.
- **Swap at Google (`sweep.ts`, approve-then-swap).** `publishing` (YouTube
  uploads of the new creatives) -> `add_to_google`: read the serving ad
  (`ad_group_ad.ad.final_urls`, `demand_gen_video_responsive_ad.logo_images`),
  then ONE `googleAds:mutate` creating any missing YOUTUBE_VIDEO assets + an
  `adGroupAd` (demandGenVideoResponsiveAd, ENABLED, same final URL and logo,
  copy from `buildAdCopy` with the new offer) in the SAME ad group ->
  `pending_google` (the old ad keeps serving; a new ad serves only once
  approved) -> the sweep reads the new ad's `policy_summary`: approved /
  approved_limited -> ONE mutate pausing the serving ad if it is the base or
  launch ad, else removing it (an older offer's ad) -> `live`
  (`campaigns.live_offer_change_id`); disapproved -> the NEW ad is removed,
  the old one keeps running, ntfy + owner told -> `disapproved`; 48 h in
  review -> one ntfy. Both offers can be live together for at most one sweep
  interval. Stats stay on the one campaign. `adPolicy` now ignores PAUSED
  ads, so the paused base's verdict never stands for the serving ad. **Not
  yet proven with a validateOnly mutate against the test customer: do that
  before the first real change.**
- **Base ad + end date (decision C).** Every change has an end date (the
  owner's, else `inferOfferExpiry`; max 92 days). The BASE = the launch ad
  when its writer input had no offer (`needsBaseCut`), recorded in
  `campaigns.base_ad_resource_name`. Otherwise (the usual case: the launch ad
  has the old offer baked in) the first change also queues ONE no-offer base
  cut (`kind = 'base'`, same reuse-only path, no preview), published and
  added to the ad group **PAUSED** (`parked`) so it is ready (and possibly
  reviewed) before it is needed; the launch ad is paused, never removed. On
  the end date: ONE mutate enabling the base and removing the offer ad ->
  `ended`; the campaign keeps running (nothing pauses it, `campaigns.status`
  stays). No base yet (its cut failed): the expired offer ad is PAUSED anyway
  and ops get an urgent ntfy (the campaign shows nothing until a base
  exists): an offer never outlives its date. A disapproved base is paged too.
- **Uploaded-video ads: the same video + ONE end slide (2026-11-22, owner
  decision).** When the launched ad has no generated (`standard`) shape but
  has launched uploads (kind `upload`, the owner's own video and/or the "Made
  from your video" copy; `changeSources` / pure `offerChangeMode`: generated
  shapes win, uploads get `slide`, else 409 `no_recut_source`), a change makes
  one NEW creative per launched shape: kind `upload`, `offer_change_id` set,
  `review_status` approved on insert (the owner's approved footage + our
  slide; rights fields copied from the source), source = that shape's
  launched `video_key`, `render_info = {engine: 'offer_slide', from, slide:
  {heading: "This month's offer", offer, until: "Until Dec 31", seconds: 4}}`
  (`offerSlideRenderInfo`). The renderer (`render/offerSlide.ts`, branched
  in `worker.ts` by `offerSlideOf`) makes it with ffmpeg + ONE voice-over
  (no fal video / Vertex / Claude): the video normalised to its own size,
  fps, SAR 1, yuv420p, 48 kHz stereo (own audio padded/trimmed to the video
  length), then a zinc-950 slide (amber heading + accent bar, the offer
  wrapped and shrunk to fit 84% of the width, "Until <date>"), joined by
  the concat filter. **The slide is read out (2026-11-22, owner decision):**
  `render_info.slide.narration` = `offerSlideNarration` (deterministic, no
  model: "This month's offer: <offer>. Until December 31st.", one closing
  full stop, the date left out when the offer already says until/ends,
  audio tags stripped), synthesized by `render/slideVoice.ts` through the
  ads' voice path (`synthesizeVoice`: fal ElevenLabs when configured, edge-tts
  fallback; voice `FAL_VOICE` / Sarah, uploads carry no voice pick) and
  cached in R2 under the ads' `voiceCacheKey` (provider | voice | text), so
  both shapes share ONE TTS call (~2-3 cents per change; an in-process
  single-flight covers concurrent renders, two renderer replicas could
  still each pay once). The voice is loudnorm'd (I=-16), 48 kHz stereo,
  starts 0.25 s into the slide; slide = max(4 s, voice + 0.6 s), capped at
  16 s (`slideSecondsFor`; raised from 10 s on 2026-11-22 after a 15.2 s
  voice-over was cut; a longer voice is still cut with a short fade). The
  web card shows "Read out on the slide in about N seconds" (estimate: about
  14 characters a second plus ~42 for the lead/date) and a warning past 16. Both
  providers failing / an unreadable file / a failed mix = the old silent
  4 s slide, never a failed change. `render_info.slide` records
  `renderedSeconds` and `voice: {provider, seconds, reused?}` or `voice:
  null, voiceError` (`seconds` stays the 4 s minimum). Text goes in through drawtext `textfile=`
  files and the fonts (`FONT_BOLD` / `FONT_REGULAR` from `render/ffmpeg.ts`,
  i.e. Dockerfile.renderer's DejaVu) are copied next to them, ffmpeg running
  in the job dir: the graph only names relative files, so nothing typed is
  parsed as filter syntax. NOT sent to YouTube on render (a preview). From
  there it is the SAME flow: preview -> two ticks / `claimBlock` /
  `reevaluateCompliance` (which now also reads `render_info.slide.offer`, as
  these cuts have no script) -> pay -> publishing -> add_to_google ->
  approved -> pause the launch ad -> live; end date -> enable the launch ad.
  **The base is the launch ad itself** (`baseCutNeeded('slide')` = false:
  `campaigns.base_ad_resource_name` = the launch ad, no base cut ever).
  The new photo / photo motion don't apply: the web card hides them for
  `mode: 'slide'` (GET returns `mode`) and a web POST with `photoAssetId`
  is 400 `photo_not_for_upload_ads`; a WhatsApp photo is ignored for it.
  The daily preview cap applies as before. Slide cuts are kept out of the
  owner's upload slots (`routes/uploads.ts`), the reformat copy check, the
  admin review list and the website video (`isNull(offer_change_id)`).
  `live_ad_is_upload` is gone (its "Upload a new video instead" was false:
  uploads to a launched campaign never reach Google). **Not yet proven with
  a real customer video and Google's review of the slide ad.**
- **Price (decision D, `lib/pricing`).** `us-offer_change` = $2 (`sku =
  offer_change`); a live evergreen plan (active / past_due) includes
  `OFFER_CHANGES_INCLUDED_PER_MONTH` = 1 per UTC calendar month, enforced by
  the unique index `uq_offer_changes_included_month` (a disapproved / failed
  / cancelled change gives it back). Admins / at_cost: `exempt`. Test mode:
  50 cents (`chargeMinor`). Paid via the shared purchases webhook
  (`onOfferChangePaid`, idempotent). An offer change on an uploaded-video ad
  (below) costs the same as any change. Revenue reporting picks the
  purchases up like any add-on (admins, test customers, internal and
  `marked_test` excluded), labelled "Offer changes ($2)" on `/admin/business`.
- **WhatsApp (decision F), behind `OFFER_SWAP_WHATSAPP` internal / on.** Off, or Meta
  unconfigured: `handleSwapInbound` returns `{handled: false}` and every
  notify is a no-op; the web card works fully without it. On: text, photo
  (+ caption; saved as an asset), voice note (fal Whisper `lib/ai/stt.ts`,
  caps in `transcriptionAllowed`, the recording deleted from R2 straight
  after, the transcript kept on the message) or the YES / Not now buttons.
  Preview = the 9:16 cut as a video message + a button message, only inside
  the 24 h window; news after that (live / back to base / problem) is free
  text inside the window, else the templates `advault_offer_change_live`,
  `advault_offer_change_ended`, `advault_offer_change_problem`. The monthly
  prompt is the existing offer cycle (templates `advault_offer_prompt` /
  `advault_offer_reminder`: {{1}} name, {{2}} business, {{3}} running-since /
  reply-by date; 2-reminder cap).
  Fixed with it: `userForPhone` wrote the regex as a backslash-D inside a JS
  template literal, which cooks to a bare `D`, so no formatted phone number
  had ever matched; it is `[^0-9]` now.
- Account deletion deletes the user's `whatsapp_messages` and cancels changes
  not yet at Google. Tests: `lib/offerSwap/policy.test.ts`,
  `lib/googleAds/adSwap.test.ts`, `routes/offerChanges.test.ts` (PGlite,
  Google stubbed: approve-then-swap, disapproval, end date -> base, no base,
  an uploaded-video ad through to live and back to its launch ad),
  `render/offerSlide.test.ts` (layout, slide length, ffmpeg args with and
  without a voice; real encodes incl. a tone standing in for the voice,
  skipped without ffmpeg), `render/slideVoice.test.ts` (TTS + R2 stubbed:
  one paid call per change),
  `lib/offerSwap/whatsapp.test.ts` (PGlite, Meta + STT stubbed).

## Not used here

No Temporal (the DB job queue covers the only async work), no mobile app, no
Supabase.

**Outbound email: password reset and the contact form** (2026-11-18; contact
form 2026-11-24: public `POST /contact`, `routes/contact.ts`, emails
`CONTACT_EMAIL` (default advault@3pandalabs.com) with Reply-To = the sender,
stores nothing, 5/hour per IP and 20/hour overall because the mailer quota is
shared with password resets; NOT fail-soft: 503 when the mail did not go out). The shared
`3pandalabs/mailer` gateway sends through Resend. Under "Option A", the one
verified sender domain is now the neutral `3pandalabs.com`, so reset mail goes
from `passwordReset@3pandalabs.com` with a per-product `fromName` — a reset from
the parent brand is legitimate for AdVault and SiteVault alike (a reset from the
old `@rsvpvault` would read as phishing). Wired via `MAILER_URL`/`MAILER_TOKEN`
+ `lib/mailer.ts` (a thin gateway client, NOT a copy of RsvpVault's; it posts to
the gateway so no Resend/Cloudflare key is ever in this app's env). Fail-soft:
unset = no mail is sent and the API still boots. The reset core is
`lib/passwordReset` (single-use token in `password_reset_tokens`, bcrypt, 30-min
TTL, enumeration-safe), reached today by the **SiteVault-proxied** routes
`POST /internal/sitevault/password-reset/{request,confirm}` and
`/change-password` (`routes/sitevaultAuth.ts`, bearer `SITEVAULT_INTERNAL_TOKEN`)
— the shared password lives here, so SiteVault owns the UI and AdVault changes
the credential. AdVault's OWN `/auth` reset pages are a fast follow that can
reuse `lib/passwordReset` unchanged. **New sign-up alert (2026-11-26,
`lib/newUserAlert.ts`):** every new account emails "AdVault New user" /
"SiteVault New user" (email, business, category, came from an ad, time, id) to
`NEW_USER_ALERT_EMAIL` (default 3pandas@3pandalabs.com; `off` disables) from
`/auth/register` and `POST /internal/sitevault/accounts` (not an older SiteVault
account being moved over, i.e. a `createdAt` over a day old, and never an
admin-made test customer). Fire-and-forget: a mailer failure never touches the
sign-up. Customers now get service emails too (next paragraph).

**Customer emails (2026-11-26, migration 0049, `lib/customerEmails`).** The
Android app sells nothing, so email (to the account's own address, from
`advault@3pandalabs.com` as "AdVault", never the reset sender) is where a
customer is told what to do next, with links to the website. Four, each
fire-and-forget (a failure only logs, nothing is claimed or sent when the
mailer is unconfigured): **welcome** (`/auth/register`, beside
`notifyNewUser`; not SiteVault sign-ups) -> /dashboard/campaigns/new;
**ad account ready** (`refreshPlatformBilling` sees platform billing go
pending -> active; once per account, `ad_accounts.ready_emailed_at` claimed
atomically) -> the newest unlaunched campaign, else /dashboard; **your ad is
ready** (after every render and YouTube upload job: when every creative of a
make, i.e. campaign + kind + version + purchase, is Ready = rendered AND on
YouTube, or gave up, with at least one Ready; once per make via
`creatives.ready_emailed_at` on the make's first creative; standard and
cinematic only, never uploads or offer-change cuts; 0049 marked everything
already on YouTube) -> the campaign page; **low ad budget** (`spendSync`, same
once-per-episode mark as the ops ping) -> `#ad-budget` on the campaign page
when one campaign is live, else /dashboard/wallet, with the real balance,
daily total and days left. Skipped (`customerEmailSkip`, one rule): deleted
accounts, test customers (`test_owner_id`) and any `*.invalid` email, and
admins by REAL role (test mode or not). Internal and `marked_test` accounts
get them. They share the gateway's `advault` quota (15/day in the mailer's
`wrangler.jsonc`) with resets, the contact form and the new-user alert.
Templates are pure (`templates.ts`, tested); the web copy for the managed
setup says "Usually done quickly. We'll email you as soon as your ad account
is ready." (campaign page, onboarding, launch's `billing_setup_pending`, FAQ):
keep it true. Tests: `lib/customerEmails/*.test.ts` (PGlite). Reset tokens are personal data: `lib/accountDeletion.ts`
deletes them with the account.

## The panda helper (2026-11-24, `web/src/lib/help`)

`PandaHelper` (root layout; hidden on /auth, /oauth and admin pages) looks like
an AI chat but is word matching over text we wrote: no model, no network,
nothing stored. FAQ answers come from `lib/help/faq.ts` (shared with /faq), the
rest from `topics.ts`. Unanswered questions go to /contact through
sessionStorage, never the URL. It says "Automatic answers"; keep that. When a
price or a screen changes, change its answer too and run
`node scripts/help-check.mjs` in `web/`.

## The privacy policy is a factual document, not boilerplate

`web/src/app/privacy/page.tsx` describes what this code actually does — what
it collects, which providers it sends data to, how long rows survive, and that
the site sets no cookies. The Google Ads API review reads it against the live
product, and a policy that overstates our practices is a written
misrepresentation rather than a harmless stale doc.

**Change it in the same PR that changes the behaviour it describes**: a new
column holding personal data, a new subprocessor, a change of retention, or the
first third-party script anyone adds to `web/`. Our own visit totals
(`web/src/lib/visitCount.ts` -> 3pandalabs/admin `visits/`, shown on the admin
page's Visitors tab) are described there. The page's own header comment
lists the specific claims that are pinned to the implementation.

## Deployment gotchas inherited from the other apps

These cost real hours elsewhere; they apply verbatim here.

- `web/package.json` build script is `next build --webpack`. Turbopack output
  is not fully supported by `@opennextjs/cloudflare` — the deploy succeeds and
  every route then 500s with `ChunkLoadError` at request time.
- Do not add a `proxy.ts`/middleware to `web/`. The adapter cannot bundle it
  (Node-only `async_hooks`). Auth lives in the dashboard layout, with the API's
  `requireAuth` as the real boundary.
- Server-side Worker code must call the API over `INTERNAL_API_URL`
  (`api-internal.advault.3pandalabs.com`, DNS-only/grey cloud), not the proxied
  public hostname — Cloudflare blocks same-account "orange-to-orange" fetches
  before any WAF rule can allow them. It is intentionally not
  `NEXT_PUBLIC_`-prefixed so browser bundles fall back to the public host.
- `web/.env.production` is committed and load-bearing. `NEXT_PUBLIC_*` is
  inlined at *build* time, so `wrangler.jsonc` `vars` (runtime) cannot supply
  it. RsvpVault shipped a bundle pointing at `localhost:8080` this way.
- In Coolify, **Base Directory** is `api` and **Dockerfile location** is
  `Dockerfile` (not `api/Dockerfile` — that resolves to `api/api/Dockerfile`).
  Ports Exposes `8080`, domains entered *with* the `https://` scheme.
- Migrations run at container start and must be idempotent (`IF NOT EXISTS`,
  `DO $$ ... WHEN duplicate_object`). A non-idempotent migration crash-loops
  the container and takes prod down — this happened to RentVault 2026-07-24.
- Do not set `MIGRATION_DATABASE_URL`. `advault_app` owns its database and runs
  its own DDL; migrating as `postgres` creates objects the runtime role cannot
  read (42501).
- The R2 `S3Client` sets `requestChecksumCalculation: "WHEN_REQUIRED"`. Without
  it the SDK bakes CRC32("") into presigned PUT URLs and every browser upload
  fails. Both RsvpVault and RentVault shipped uploads that could never succeed
  this way. The R2 CORS policy (`infra/r2-cors.json`) is the other half of the
  same failure — fix both together or neither is testable.

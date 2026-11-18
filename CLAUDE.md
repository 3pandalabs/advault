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
Activity** wrapping the web app for Google Play (`com.threepanda.advault`;
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
- **Launch requires a plan that buys media** (`launchPlanBlock`, managed or
  evergreen; 402 `plan_required` / `plan_has_no_ads`). Admins and at_cost
  accounts are exempt. Until 2026-11-11 launch never checked, so anyone could
  run ads without paying the fee.
- `campaigns.status` only reaches `live` through `POST /campaigns/:id/launch`,
  which is the single place that spends money. Keep it that way — no other
  route may call the Google Ads mutate API.

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
  nothing recording the swap.
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
- `/admin/metrics` takes an admin session or the optional
  `ADMIN_ANALYTICS_TOKEN`, never the shared `METRICS_TOKEN`: it names
  businesses and their spend, which `/metrics` deliberately never does.

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
- No automated scanning. Google Video Intelligence explicit-content detection
  (~5¢/video) is the noted future option; it would not replace the human check.

Google reviews the ad again after launch: `adMetricsSync` also reads
`ad_group_ad.policy_summary` (read-only) into `campaigns.google_ad_*`, shown on
the campaign page as "Google: Approved / Under review / Disapproved".

## Real estate: listing/open-house ads and agent ads

A real-estate campaign picks one (2026-11-13, `campaigns.realty`, `lib/realty`):
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
- **$10 website fee (2026-11-15, migration 0024, `lib/websiteFee`).** For advertisers who pay per ad (`paysPerAd`; admins/at_cost stay free and publish at once), "Make me a website" creates the SiteVault site with `awaitingPayment=1` (unpublished), stores it in `campaigns.sitevault_pending_url` (NOT `landing_url`), and sends them to a $10 Stripe checkout (`sku = website`, `us-website`, first year of SiteVault Pro included, then $49/yr on SiteVault). The shared purchase webhook marks it paid and fires `publishPaidWebsite` (SiteVault `POST /api/internal/sites/<slug>/paid`, `ref` = purchase id, idempotent); only on success does the site become `landing_url` (never overwriting a link the owner typed meanwhile) and the purchase `delivered`. The API sweep retries every 10 minutes, up to 5 attempts. `POST /campaigns/:id/website/checkout` re-opens checkout for an abandoned payment; `GET /campaigns/:id/website` returns `pendingSite` / `websiteFee`. Launch needs `landing_url`, so an unpaid site blocks launch by itself.
- **Offer combo (2026-11-15, migration 0023, `lib/siteOffer`).** Buying a $10 new ad for a campaign whose link is a SiteVault site (and that has offer text) shows "Also put this offer on my website": +$2 (`SITE_OFFER_ADDON` in `lib/pricing`, US only, a second Stripe line item, so $12 total), or "uses 1 of your N website credits" ($10 total) when SiteVault billing is on and the site has a credit, or "(free)" when SiteVault billing is off. Always PAID here; SiteVault only applies it. The mode is decided server-side at checkout from SiteVault `GET /api/internal/sites/<slug>/offer-status` (pure `siteOfferQuote` in `policy.ts`, tested); unreachable SiteVault, a paused/unpublished site or no offer text hides or refuses the option (`site_offer_unavailable`), never a guess. Recorded on the purchase (`site_offer_mode/text/slug/pushed_at/error/attempts`). After payment the webhook fires the push (`POST /api/internal/sites/<slug>/offer`, `payment` advault for paid/free, credit for credit, `ref` = purchase id, idempotent on SiteVault's side) without awaiting it: **a SiteVault failure must never fail or delay the ad purchase.** The API (only it holds the token) sweeps every 10 minutes and retries up to 5 attempts. Admins / at_cost get it free via `POST /campaigns/:id/site-offer` (a $0 `sku = 'site_offer'` row). Deep link from SiteVault's edit page: `/dashboard?siteOffer=<slug>` opens the matching campaign with the box ticked. The website card shows "Offer on your website: updated / pending / couldn't update — we'll retry".
- **Before & after (2026-11-17, migration 0029, `lib/beforeAfter`).** Trades only (`beforeAfterAllowed`: the wizard's Plumbing/Electrical/HVAC/Landscaping/Auto repair/Cleaning presets, plus typed-in trades like roofing, painting, remodeling, pressure washing, detailing, flooring, junk removal; NEVER health, dental, cosmetic, salon, spa, fitness or anything body-related, because Google restricts before/after for personal health & cosmetic results; not food, retail or real estate). Browser mirror `web/src/lib/beforeAfter.ts`, kept word for word by a test. Up to 2 pairs on `campaigns.before_after` `[{beforeAssetId, afterAssetId}]` + `before_after_attested_at/by` ("These are real photos of our own work.", required), set by `PUT /campaigns/:id/before-after` from the wizard's photo step or the campaign page's card (changes affect the NEXT ad made, never the current one). **Honesty rule in code:** `generateForCampaign` keeps pair photos OUT of `sourceAssetKeys` and puts their R2 keys on `script.beforeAfter` (never trusted from a script edit), so they never get the photo pass or motion; the renderer also skips any pair key that is in `sourceAssetKeys` (`plainPhotoIndexes`). Both halves get the same plain treatment. The template shows each pair full screen after the opener, 3.5 s: BEFORE, a left-to-right wipe, AFTER (whole photo over a blurred copy, no zoom); the ffmpeg fallback shows BEFORE then AFTER stills, labelled, after scene 1. The script writer is told the pairs exist and may say "from this… to this", never specifics. "Make me a website" sends them (original photos) to SiteVault as files `ba1Before`/`ba1After`/`ba2Before`/`ba2After` (sitevault PR #61); an older SiteVault Worker would not store them, so deploy SiteVault first.
- The end card shows the landing page's domain, never a phone number we
  weren't given for the purpose.

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
| `evergreen` ("Keep it running") — one ad kept live, no monthly offer, $10 per ad | not sold | $19/mo fee |

**Evergreen never enters the offer loop.** No offer cycles, no WhatsApp prompt,
and `POST /offers/current` refuses it (`plan_has_no_offers`): an offer sets an
expiry that pauses the campaign, which is the opposite of what the plan sells.
Use `hasMonthlyOffers(line)` rather than comparing line names.

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

`inferOfferExpiry()` ALWAYS returns a date, falling back to end of month. That
property matters more than the parsing: an offer campaign outliving its deadline
spends the advertiser's budget sending people to a deal the shop will not
honour, and nothing at Google expires an ad for us. The sweep in
`render/offerCycles.ts` pauses them.

## Not used here

No Temporal (the DB job queue covers the only async work), no mobile app, no
Supabase.

**Outbound email: password reset only** (2026-11-18). The shared
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
reuse `lib/passwordReset` unchanged. Still no render-complete notification; the
dashboard polls. Reset tokens are personal data: `lib/accountDeletion.ts`
deletes them with the account.

## The privacy policy is a factual document, not boilerplate

`web/src/app/privacy/page.tsx` describes what this code actually does — what
it collects, which providers it sends data to, how long rows survive, and that
the site sets no cookies. The Google Ads API review reads it against the live
product, and a policy that overstates our practices is a written
misrepresentation rather than a harmless stale doc.

**Change it in the same PR that changes the behaviour it describes**: a new
column holding personal data, a new subprocessor, a change of retention, or the
first analytics script anyone adds to `web/`. The page's own header comment
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

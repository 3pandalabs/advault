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
`infra/` (runbooks). Same shape as `3pandalabs/evitevault`. No `app/` — there
is no mobile client; the advertiser workflow is a desktop-first web app.

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
- `campaigns.status` only reaches `live` through `POST /campaigns/:id/launch`,
  which is the single place that spends money. Keep it that way — no other
  route may call the Google Ads mutate API.

## A rendered MP4 is not an ad — the chain is five links

A Google Ads video ad references an **11-character YouTube video id**, never an
MP4 URL. So producing an ad is:

```
rendered MP4  ->  YouTube video id  ->  Asset  ->  AdGroup  ->  AdGroupAd
   (R2)          (lib/youtube/*, its   (YOUTUBE_  (type is    (videoAd)
                  own queue)            VIDEO)    immutable)
```

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
- **`videoAdFormatFor()` derives the ad group type from the real rendered
  duration** (bumper ≤6s, non-skippable ≤15s, skippable beyond). The type is
  IMMUTABLE at Google, so getting it wrong means deleting and recreating the ad
  group. It is the one piece of pure logic here and it is tested.
- **`VideoResponsiveAdInfo` is deliberately not used.** It requires
  `business_name` *and* `logo_images` at ≥128x128, 1:1. `assets.kind` has a
  'logo' value but it is optional and unvalidated, so the responsive format
  would make a square logo a mandatory onboarding step and fail launches for
  everyone already signed up without one.
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
only links a payments account that already exists. So `platform` is fully
automatic and `customer` is not automatable at all: the advertiser accepts an
account invitation and enters a card in Google's own UI, and the only signal
available is polling for a funded `billing_setup`. Do not add a "mark as done"
control — a self-reported yes produces a campaign that launches successfully and
then silently never serves, which is strictly worse than an honest blocked
state.

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
strings. `lib/pricing` now holds four SKUs and one of them has to be sold:

| Line | India | US |
|---|---|---|
| `offer` — 3 fresh videos/month, **no Google at all** | ₹999/mo | $39/mo |
| `managed` — creatives plus a live campaign | ₹1,499/mo fee | $79/mo fee |

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

## The cinematic add-on is TEXT-to-video, and that is the whole point

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

**No outbound email**, deliberately. The shared `3pandalabs/mailer` gateway
sends through Resend, and only `rsvpvault.3pandalabs.com` is a verified sender
domain — adding a second one evicts it. So there is no password-reset flow and
no render-complete notification yet; the dashboard polls instead. When a second
Resend domain becomes available, add `MAILER_URL`/`MAILER_TOKEN` and copy
RsvpVault's `lib/mailer.ts` verbatim rather than writing a new one.

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

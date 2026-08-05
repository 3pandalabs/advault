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
  the user id (`src/lib/oauthState.ts`). Without it the callback is a CSRF
  primitive that attaches an attacker's ad account to a victim's login.
- `campaigns.status` only reaches `live` through `POST /campaigns/:id/launch`,
  which is the single place that spends money. Keep it that way — no other
  route may call the Google Ads mutate API.

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
Postgres nor an approved developer token.

## Not used here

No Temporal (the DB job queue covers the only async work), no mobile app, no
Supabase.

**No outbound email**, deliberately. The shared `3pandalabs/mailer` gateway
sends through Resend, and only `rsvpvault.3pandalabs.com` is a verified sender
domain — adding a second one evicts it. So there is no password-reset flow and
no render-complete notification yet; the dashboard polls instead. When a second
Resend domain becomes available, add `MAILER_URL`/`MAILER_TOKEN` and copy
RsvpVault's `lib/mailer.ts` verbatim rather than writing a new one.

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

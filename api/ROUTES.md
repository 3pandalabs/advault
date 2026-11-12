# AdVault API routes

Base: `https://api.advault.3pandalabs.com`. Server-side Worker code uses
`api-internal.advault.3pandalabs.com` instead (see the repo CLAUDE.md).

**Every route below `/auth` requires a bearer access token.** Unlike RsvpVault,
this app has no anonymous product routes at all — nothing an advertiser creates
is meant to be readable without a login.

## Ops

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/health` | none | `{ ok: true }` |
| GET | `/metrics` | `METRICS_TOKEN` bearer | Shared org envelope. 503 when the token is unset. |

## Auth

| Method | Path | Notes |
|---|---|---|
| POST | `/auth/register` | 409 `registration_failed` for a taken address — deliberately indistinguishable from any other rejection. |
| POST | `/auth/login` | |
| POST | `/auth/refresh` | Rotates: the presented token is destroyed. |
| POST | `/auth/logout` | Always 204. |
| GET | `/auth/me` | |
| PATCH | `/auth/me` | Profile fields only — never email or role. |
| DELETE | `/auth/sessions` | Signs out everywhere. |

No password reset — the shared mailer has no verified sender for this app. See
CLAUDE.md.

## Assets

| Method | Path | Notes |
|---|---|---|
| POST | `/assets/presign-upload` | Key is generated server-side from the caller's user id, never accepted from the client. |
| POST | `/assets` | Confirms an upload. Rejects a key not minted for this user. |
| GET | `/assets` | |
| POST | `/assets/presign-download` | Authorized by the key's `users/<id>/` prefix. |
| DELETE | `/assets/:assetId` | Deletes the row, then best-effort deletes the object. |

## Campaigns

| Method | Path | Notes |
|---|---|---|
| POST | `/campaigns` | Creates a draft. Nothing chargeable. |
| GET | `/campaigns` | |
| GET | `/campaigns/:campaignId` | Includes creatives — what the dashboard polls. |
| PATCH | `/campaigns/:campaignId` | 409 `campaign_is_live`. |
| DELETE | `/campaigns/:campaignId` | 409 `campaign_is_live` — deleting the row would not stop the spend. |
| GET | `/campaigns/:campaignId/metrics?days=7` | Owner only. `{launched, days, since, currency, note, totals, daily[], lastSyncedAt}`. `days` 1–90 (default 7). Each summary: `impressions, views, clicks, spendMinor, spendDisplay, costPerViewMinor, costPerViewDisplay, ctr, viewRate` (rates 0..1, null with no denominator). Reads `campaign_daily_metrics`, never Google; `totals` is null before launch. |

## Admin analytics

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/admin/metrics?days=7` | admin session, or `ADMIN_ANALYTICS_TOKEN` bearer | Every launched campaign (live + paused) with business name, owner email, status, currency, Google customer id and the same totals summary; plus `totals` keyed by currency (never summed across currencies). The token is for a server-side caller such as the org admin site's Worker; unset = admin sessions only. Deliberately NOT `METRICS_TOKEN` — this names businesses and their spend. |

## Creatives

| Method | Path | Notes |
|---|---|---|
| — | (launch) | `POST /campaigns/:id/launch` answers **402 `plan_required`** without a live plan, **402 `plan_has_no_ads`** on the offer line. Admins and at_cost accounts are exempt; skipped on `validateOnly`. |
| POST | `/campaigns/:campaignId/creatives/generate` | **202.** Writes the scripts, queues the renders, returns. One creative per requested aspect ratio. **402 `new_ad_payment_required`** for a Keep it running subscriber whose campaign has no paid ad yet. |
| GET | `/new-ad/quote` | `{required, display}`: does this user pay per ad (Keep it running), and how much. |
| GET | `/campaigns/:campaignId/new-ad` | `{required, display, order}`: the campaign's latest new-ad order. |
| POST | `/webhooks/stripe` | **The only Stripe endpoint to register.** Routes each event to the payments / purchases / subscriptions handler (which verify the signature); 200 `ignored` for other apps on the shared account and unwanted events. See infra/stripe-setup.md. |
| POST | `/campaigns/:campaignId/new-ad/order` | Opens a $19 checkout. Body `{assetIds, aspectRatios}` is saved on the order; omit it to reuse the last order's. 409 `ad_included_in_plan` / `already_paid` / `campaign_is_live`. Paid via the shared `/webhooks/purchases/:provider`. |
| POST | `/new-ad/orders/:purchaseId/generate` | Spends a paid order: generates from its saved choices, marks it delivered. 409 `payment_pending` / `in_progress`; 200 `alreadyGenerated`. |
| GET | `/campaigns/:campaignId/creatives` | |
| PATCH | `/creatives/:creativeId/script` | Hand-edited copy, re-validated against the generator's own schema. Re-queues the render. 409 `creative_is_upload` for uploaded videos. |
| POST | `/creatives/:creativeId/retry` | 409 `already_rendering`. |
| POST | `/creatives/download-url` | Authorized by the key's `campaigns/<id>/` prefix. |
| POST | `/campaigns/:campaignId/creatives/upload-url` | **Admin only**, own campaigns only. Body `{width, height, durationSeconds}` (read in the browser); refuses non-9:16/16:9, <720p, <5s or >180s. Returns `{creativeId, uploadUrl, contentType}` for a PUT to R2. |
| POST | `/campaigns/:campaignId/creatives/upload` | **Admin only.** Confirms the PUT: HEADs the object (exists, video/mp4, ≤200 MB), inserts a `kind='upload'` creative already `ready`, queues the YouTube upload. 201. |
| DELETE | `/creatives/:creativeId` | **Admin only**, uploads only, own campaigns. 409 `creative_is_live` once the campaign/ad exists at Google, `upload_in_progress` mid-publish. Deletes the row (jobs cascade) and the R2 object; the YouTube copy stays. 204. |

## Google Ads

| Method | Path | Notes |
|---|---|---|
| GET | `/ad-accounts` | `{ configured, managedOffered, accounts }` — `configured` is false until Google Ads credentials are set; `managedOffered` says AdVault can create and pay for an account itself (platform billing). |
| GET | `/ad-accounts/google/authorize-url` | 503 `google_ads_not_configured`. Issues the signed, single-use state. |
| POST | `/ad-accounts/google/callback` | Exchanges the code server-side. May return `{ needsSelection, customerIds }`. |
| POST | `/ad-accounts/managed` | Creates an MCC child. Body `{ billingMode, campaignId? }` — `billingMode` required when both modes are offered, refused when the requested one is not; `campaignId` sizes the first Mercury card limit. If Google refuses creation (`CREATION_DENIED_INELIGIBLE_MCC`, MCC under $1,000 of linked spend), a platform request still returns 201 with a `customerId: null`, `provisionStatus: 'pending'` row and the operator creates the account by hand (see infra/managed-billing.md). Platform accounts are created in USD, get a Mercury card and an operator alert, and wait in `billingLinkStatus: 'pending'` until the card is on (see infra/managed-billing.md). Idempotent per user. 503 `google_ads_mcc_not_configured`. |
| DELETE | `/ad-accounts/:adAccountId` | Revokes at Google best-effort, then deletes the row. The managed child is **not** deleted at Google. |

`ad_accounts` responses are shaped exclusively by `toPublicAdAccount()` in
`routes/adAccounts.ts`. **No route may return a token or any part of one.**

## Billing mode — the onboarding branch

`ad_accounts.is_managed` says whether AdVault provisioned the account;
`ad_accounts.billing_mode` says **whose card Google charges**. They are
independent, and conflating them is what made the customer-funded MCC child
inexpressible in the original design.

| Method | Path | Notes |
|---|---|---|
| GET | `/ad-accounts/billing-options` | `{ modes, prompt, mccConfigured }`. `prompt` is true only when both modes are offered — that is what decides whether the wizard shows a choice step. |
| GET | `/ad-accounts/:adAccountId/billing-status` | Polls Google for the invitation and, decisively, for a funded `billing_setup`. Answers from the row without a Google call when the account cannot change. `polling` goes false when terminal. |
| POST | `/ad-accounts/:adAccountId/billing/resend-invite` | 409 when the account has no invitation to resend or billing is already live. 502 when Google refuses. |
| POST | `/ad-accounts/:adAccountId/billing-mode` | Switches modes. 409 `unsupported_switch` on a brought-your-own account — there is nothing to attach our billing to. |
| GET | `/billing/summary` | Ad spend AdVault fronted, separately from AdVault's own fees. `passThrough` is `null` (not zero) for a customer-funded advertiser, so "not applicable" is distinguishable from "nothing yet". |

**There is no Google Ads API that adds a payment method.** `BillingSetupService`
can only point an account at a payments account that already exists. So
`billing_mode = 'platform'` is fully automatic (we attach the MCC's payments
account), and `'customer'` is not automatable at all — the advertiser accepts an
invitation and enters a card in Google's own UI, and the only signal we get is
polling for a `billing_setup`. Do not add a "mark as done" control.

Deployment config: `ADVAULT_BILLING_MODES` (`platform`, `customer`, or both,
comma separated; defaults to both). Platform is additionally gated on the MCC
being configured. An unparseable value falls back to both rather than taking
signup offline.

## Launch

| Method | Path | Notes |
|---|---|---|
| POST | `/campaigns/:campaignId/launch` | **The only route in this codebase that spends money.** Body `{ adAccountId, validateOnly? }`. Builds a **Demand Gen** campaign in one atomic Google request: PAUSED for customer-billed and BYO accounts, ENABLED for platform-billed ones (the customer has no Google access to switch it on). `validateOnly: true` is a dry run: Google checks everything, nothing is created, and the billing and wallet gates are skipped. |

Two guards run in order, and they ask different questions. The **billing gate**
asks whether Google will accept spend on this account at all; the **wallet
guard** asks whether we can afford it, and applies only to
`billing_mode = 'platform'`.

Failure codes worth handling in a client: `google_ads_not_configured` (503),
`ad_account_revoked` (409), `billing_not_configured` (409),
`billing_link_failed` (409), `provisioning_incomplete` (409),
`billing_setup_pending` (409, waiting for the operator's card), `currency_mismatch` (409),
`insufficient_funds` (402), `no_ready_creatives` (409), `already_launched` (409),
`no_resolvable_zip_codes` (400), `logo_required` (409), `logo_invalid` (409,
with `reason`), `manager_account` (409), `google_ads_error` (502, `detail`
lists Google's per-field reasons).

`billing_not_configured` is the one that matters most: without it, launching
into a customer-funded account with no card **succeeds** and the campaign then
silently never serves.

The campaign is created **PAUSED** at Google. The response's `note` says so, and
`zipCodesRequested`/`zipCodesTargeted` report how many ZIPs Google actually
recognised.

## Error shape

`{ "error": "<code>" }`, plus `details` on a Zod validation failure and `detail`
on a launch failure. Postgres `23505` maps to 409 `conflict`; `23514` (a CHECK
constraint) maps to 400 `invalid_request`.

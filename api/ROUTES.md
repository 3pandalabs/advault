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
| GET | `/auth/me/deletion` | Preview for the confirmation screen: `{ liveCampaigns, activePlan, walletBalanceMinor, currencyCode }`. |
| POST | `/auth/me/delete` | `{ password }`. **204**; 403 `wrong_password`; 401 `account_deleted`. See below. |

### Account deletion

Google Play requires it in-app (`lib/accountDeletion.ts`). Nothing blocks it.
In order: live campaigns are paused at Google (MCC token, best effort; still
flipped to `paused` locally if Google refuses), then in one transaction the plan
is cancelled immediately, sessions, YouTube channel rows and brought-your-own
Google Ads rows (encrypted refresh tokens) are deleted, uploaded photos/logos
are deleted (R2 objects after commit), and the user row is **anonymised, not
deleted**: payments, purchases, invoices, campaigns and the wallet ledger
cascade from it and are the financial records we keep. Email →
`deleted+<id>@advault.invalid`, password → an unusable hash, name →
"Deleted user", business name/category/phone → null, `deleted_at` → now.
Managed Google Ads rows stay (MCC children with our Mercury card). Ops get one
ntfy alert listing the manual clean-up: freeze the Mercury card, refund any
wallet balance, pause anything Google refused, remove videos from AdVault's
YouTube channel. Already-issued access tokens get 401 `account_deleted`
(`auth/deleted.ts`) and expire within 15 minutes regardless; the address can
sign up again as a new account.

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
| POST | `/campaigns` | Creates a draft. Nothing chargeable. Optional `audienceFilters` `{ages?, genders?, parentalStatuses?, incomes?, languages?}` (null/absent = everyone; values in `lib/audience/policy.ts`) and, for real estate, `targetAddress` `{street, city, state, postalCode}` with `targetZipCodes: []`. **400** `housing_demographics_not_allowed` / `housing_zip_targeting_not_allowed` / `listing_address_required` / `zip_codes_required` with a `detail` sentence (US housing-ads policy: no age, gender, parental status or ZIP targeting; income and language allowed).  Real estate also takes `realty` `{adType: 'listing'|'agent', price?, beds?, baths? (.5 steps), openHouse?: {date, start, end}}` (lib/realty): a listing ad names the street, price, beds/baths and open house; an agent ad promotes the agent and city. |
| GET | `/campaigns` | |
| GET | `/campaigns/:campaignId` | Includes creatives — what the dashboard polls. |
| PATCH | `/campaigns/:campaignId` | 409 `campaign_is_live`. Same targeting fields and 400s as POST, checked against the row as it would be after the patch. |
| DELETE | `/campaigns/:campaignId` | 409 `campaign_is_live` — deleting the row would not stop the spend. |
| GET | `/campaigns/:campaignId/metrics?days=7` | Owner only. `{launched, days, since, currency, note, totals, daily[], lastSyncedAt}`. `days` 1–90 (default 7). Each summary: `impressions, views, clicks, spendMinor, spendDisplay, costPerViewMinor, costPerViewDisplay, ctr, viewRate` (rates 0..1, null with no denominator). Reads `campaign_daily_metrics`, never Google; `totals` is null before launch. |

## Admin analytics

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/admin/metrics?days=7` | admin session, or `ADMIN_ANALYTICS_TOKEN` bearer | Every launched campaign (live + paused) with business name, owner email, status, currency, Google customer id and the same totals summary; plus `totals` keyed by currency (never summed across currencies). The token is for a server-side caller such as the org admin site's Worker; unset = admin sessions only. Deliberately NOT `METRICS_TOKEN` — this names businesses and their spend. |
| GET | `/admin/ad-production?since=YYYY-MM-DD&until=YYYY-MM-DD` | admin session, or `ADMIN_ANALYTICS_TOKEN` bearer | Counts only, for the org admin site's cost per ad: `adsMade` (generations: distinct campaign + minute of AdVault-made creatives), `renders` (AdVault-made creatives, one per format, redos included), `paidAds` ($10 `new_ad` orders paid). `until` exclusive. |
| GET | `/admin/recent-renders?limit=10` | admin session, or `ADMIN_ANALYTICS_TOKEN` bearer | The last renders (1–50): business, format, status/error, and `renderInfo` (engine template/ffmpeg, motion provider, clips made and reused, voice source) plus the script's sticker and people/portrait marks. Ops diagnostics without container logs. |

## Creatives

| Method | Path | Notes |
|---|---|---|
| — | (launch) | `POST /campaigns/:id/launch` answers **402 `plan_required`** without a live plan, **402 `plan_has_no_ads`** on the offer line. Admins and at_cost accounts are exempt; skipped on `validateOnly`. |
| POST | `/campaigns/:campaignId/creatives/generate` | **202.** Writes the scripts, queues the renders, returns. One creative per requested aspect ratio. **402 `new_ad_payment_required`** (`{display, rendersPerAd}`) for any advertiser (not admin / `at_cost`) whose campaign has no paid `new_ad` with renders left. Spends one of the paid ad's `RENDERS_PER_AD` (3: first + 2 redos, `purchases.renders_used`), given back if generation is refused. No free first ad since 2026-11-13. |
| GET | `/new-ad/quote` | `{required, display}`: does this user pay per ad (everyone but admins and `at_cost`), and how much. |
| GET | `/campaigns/:campaignId/new-ad` | `{required, display, order}`: the campaign's latest new-ad order. |
| POST | `/webhooks/stripe` | **The only Stripe endpoint to register.** Routes each event to the payments / purchases / subscriptions handler (which verify the signature); 200 `ignored` for other apps on the shared account and unwanted events. See infra/stripe-setup.md. |
| POST | `/campaigns/:campaignId/new-ad/order` | Opens a $10 checkout. Body `{assetIds, aspectRatios}` is saved on the order; omit it to reuse the last order's. 409 `ad_included_in_plan` (admin / `at_cost`) / `already_paid` (a paid ad not made yet, or made with renders left) / `campaign_is_live`. Paid via the shared `/webhooks/purchases/:provider`. |
| POST | `/new-ad/orders/:purchaseId/generate` | Spends a paid order: generates from its saved choices, marks it delivered with `renders_used = 1`. 409 `payment_pending` / `in_progress`; 200 `alreadyGenerated`. |
| GET | `/campaigns/:campaignId/creatives` | |
| PATCH | `/creatives/:creativeId/script` | Hand-edited copy, re-validated against the generator's own schema. Re-queues the render, spending one render (402 `new_ad_payment_required` when none left). 409 `creative_is_upload` for uploaded videos. |
| POST | `/creatives/:creativeId/retry` | Free, **failed renders only** (409 `not_failed` otherwise, so it can't be a free re-render). 409 `already_rendering`. |
| POST | `/creatives/download-url` | Authorized by the key's `campaigns/<id>/` prefix. |
| POST | `/campaigns/:campaignId/creatives/upload-url` | "Use my own video". Any user, own campaigns only. Body `{width, height, durationSeconds}` (read in the browser); refuses non-9:16/16:9, <720p, and lengths outside **6–60s** for customers (5–180s for admins). Returns `{creativeId, uploadUrl, contentType}` for a PUT to R2. |
| POST | `/campaigns/:campaignId/creatives/upload` | Confirms the PUT. Body adds `creativeId` and **`rightsAttested: true` (required)**; who/when is stored. HEADs the object (exists, video/mp4, ≤200 MB), inserts a `kind='upload'` creative already `ready`. A customer's is `reviewStatus: 'pending_review'`, is **not** published to YouTube and pings ops (ntfy); an admin's is `approved` and queues the YouTube upload. 201. |
| DELETE | `/creatives/:creativeId` | Uploads only, own campaigns. 409 `creative_is_live` once the campaign/ad exists at Google, `upload_in_progress` mid-publish. Deletes the row (jobs cascade) and the R2 object; a YouTube copy, if any, stays. 204. |
| POST | `/creatives/:creativeId/youtube-upload` | (in youtube.ts) now also 409 `video_pending_review` / `video_rejected` for an upload not approved. `/youtube/backfill` skips them. |

## Admin: uploaded-video review

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/admin/video-reviews?status=pending_review` | admin session, or `ADMIN_ANALYTICS_TOKEN` bearer | `{status, videos[]}`, `status` one of `pending_review` (default, oldest first) / `approved` / `rejected` (newest first), max 100. Each: business, campaign, owner email, landing URL, aspect, duration, size, attestation time, review fields, and a 10-minute `videoUrl`. |
| POST | `/admin/video-reviews/:creativeId` | same | Body `{decision:'approve'}` or `{decision:'reject', reason}`. Only from `pending_review` (409 `already_reviewed` / `not_reviewable`; 400 `reason_required`). Approve queues the YouTube upload. Records `reviewed_by` (null for a token caller) and `reviewed_at`. |

Launch answers **409 `video_pending_review`** while any of the campaign's uploads awaits review (dry run included), and **409 `video_rejected`** when rejected uploads were the only videos; rejected uploads are otherwise left out of the ad.

Campaign rows also carry Google's own review of the launched ad — `googleAdApprovalStatus`, `googleAdReviewStatus` (raw `ad_group_ad.policy_summary` enums), `googleAdPolicyTopics`, `googleAdPolicyCheckedAt` — copied hourly by the renderer.

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
| POST | `/campaigns/:campaignId/launch` | **The only route in this codebase that spends money.** Body `{ adAccountId, validateOnly? }`. Builds a **Demand Gen** campaign in one atomic Google request: PAUSED for customer-billed and BYO accounts, ENABLED for platform-billed ones (the customer has no Google access to switch it on). `validateOnly: true` is a dry run: Google checks everything, nothing is created, and the billing and wallet gates are skipped. Re-checks the targeting rules first (**409** with the same codes as POST `/campaigns`, dry run included). Demographic filters become one `Audience` (age/gender/parental/income dimensions) attached to the ad group (`audienceSetting.useAudienceGrouped`); languages are `language` criteria. Real estate targets a `proximity` campaign criterion around `targetAddress` (campaign created with `demandGenCampaignSettings.upgradedTargeting: false`). Response adds `radiusMilesAroundAddress` (null for ZIP campaigns) and `audienceFiltersApplied`. |

Two guards run in order, and they ask different questions. The **billing gate**
asks whether Google will accept spend on this account at all; the **wallet
guard** asks whether we can afford it, and applies only to
`billing_mode = 'platform'`.

Failure codes worth handling in a client: `google_ads_not_configured` (503),
`ad_account_revoked` (409), `billing_not_configured` (409),
`billing_link_failed` (409), `provisioning_incomplete` (409),
`billing_setup_pending` (409, waiting for the operator's card), `currency_mismatch` (409),
`insufficient_funds` (402), `no_ready_creatives` (409), `already_launched` (409),
`video_pending_review` (409), `video_rejected` (409),
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

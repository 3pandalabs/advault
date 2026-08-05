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

## Creatives

| Method | Path | Notes |
|---|---|---|
| POST | `/campaigns/:campaignId/creatives/generate` | **202.** Writes the scripts, queues the renders, returns. One creative per requested aspect ratio. |
| GET | `/campaigns/:campaignId/creatives` | |
| PATCH | `/creatives/:creativeId/script` | Hand-edited copy, re-validated against the generator's own schema. Re-queues the render. |
| POST | `/creatives/:creativeId/retry` | 409 `already_rendering`. |
| POST | `/creatives/download-url` | Authorized by the key's `campaigns/<id>/` prefix. |

## Google Ads

| Method | Path | Notes |
|---|---|---|
| GET | `/ad-accounts` | `{ configured, accounts }` — `configured` is false until the developer token is set. |
| GET | `/ad-accounts/google/authorize-url` | 503 `google_ads_not_configured`. Issues the signed, single-use state. |
| POST | `/ad-accounts/google/callback` | Exchanges the code server-side. May return `{ needsSelection, customerIds }`. |
| POST | `/ad-accounts/managed` | Creates an MCC child. Body `{ billingMode }` — required when both modes are offered, refused when the requested one is not. Idempotent per user. 503 `google_ads_mcc_not_configured`. |
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
| POST | `/campaigns/:campaignId/launch` | **The only route in this codebase that spends money.** |

Two guards run in order, and they ask different questions. The **billing gate**
asks whether Google will accept spend on this account at all; the **wallet
guard** asks whether we can afford it, and applies only to
`billing_mode = 'platform'`.

Failure codes worth handling in a client: `google_ads_not_configured` (503),
`ad_account_revoked` (409), `billing_not_configured` (409),
`billing_link_failed` (409), `provisioning_incomplete` (409),
`insufficient_funds` (402), `no_ready_creatives` (409), `already_launched` (409),
`no_resolvable_zip_codes` (400), `google_ads_error` (502).

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

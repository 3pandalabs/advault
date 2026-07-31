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
| DELETE | `/ad-accounts/:adAccountId` | Revokes at Google best-effort, then deletes the row. |

`ad_accounts` responses are shaped exclusively by `toPublicAdAccount()` in
`routes/adAccounts.ts`. **No route may return a token or any part of one.**

## Launch

| Method | Path | Notes |
|---|---|---|
| POST | `/campaigns/:campaignId/launch` | **The only route in this codebase that spends money.** |

Failure codes worth handling in a client: `google_ads_not_configured` (503),
`ad_account_revoked` (409), `no_ready_creatives` (409), `already_launched` (409),
`no_resolvable_zip_codes` (400), `google_ads_error` (502).

The campaign is created **PAUSED** at Google. The response's `note` says so, and
`zipCodesRequested`/`zipCodesTargeted` report how many ZIPs Google actually
recognised.

## Error shape

`{ "error": "<code>" }`, plus `details` on a Zod validation failure and `detail`
on a launch failure. Postgres `23505` maps to 409 `conflict`; `23514` (a CHECK
constraint) maps to 400 `invalid_request`.

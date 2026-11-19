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
| POST | `/auth/login` | Password length isn't checked here (only on register), because accounts made on SiteVault may have 8–9 characters. |
| POST | `/auth/refresh` | Rotates: the presented token is destroyed. |
| POST | `/auth/logout` | Always 204. |
| GET | `/auth/me` | Also `signupApp` (`advault` / `sitevault`) and `usesSitevault` (the account has a SiteVault website); the empty dashboard links to SiteVault when either says so. `testAsCustomer`: admin "Test as customer" is on (`role` stays the real role). |
| PATCH | `/auth/me/test-mode` | `{ on: boolean }` → `{ testAsCustomer }`. Admins only (real role from the DB): **403** `admin_role_required` otherwise, 401 without a session. While on, the admin is billed like a standard advertiser (plan gate at launch, $10 ad, website fee, offer combo, redo metering, own-video closed, video bundle paid, one website per account) and every Stripe charge is 50 cents (`TEST_PRICE_MINOR`), tagged `metadata.test_mode=1`; subscriptions use an inline monthly `price_data`. Ad budget top-ups are unchanged. Admin routes keep the real role. `GET /plans` with a session reports `testMode` and the test fee. See `lib/testMode`. |
| PATCH | `/auth/me` | Profile fields only (`displayName`, `businessName`, `businessCategory`, `phone`; `null` clears) — never email or role, which are stripped. **400** `nothing_to_update` when no profile field is left (`{}`, or only email/role); it was a 500. |
| DELETE | `/auth/sessions` | Signs out everywhere. |
| GET | `/auth/me/deletion` | Preview for the confirmation screen: `{ liveCampaigns, activePlan, walletBalanceMinor, currencyCode }`. |
| POST | `/auth/me/delete` | `{ password }`. **204**; 403 `wrong_password`; 401 `account_deleted`. See below. |

### Admin test customers (0030, `routes/testCustomers.ts`)

Separate customer accounts a real admin owns (`users.test_owner_id`) and switches into, so one-per-account things (website, ad account, Mercury card, plan) can be tested from scratch. Real admin = `users.role` from the DB (never the JWT). From inside a test customer, these act for its owner.

| Method | Path | Notes |
|---|---|---|
| GET | `/test-customers` | `{ customers: [{ id, name, createdAt }], current }` (`current` = the test customer this session is in, else null). **403** `admin_role_required` for anyone else. |
| POST | `/test-customers` | `{ name }` → **201** `{ id, name, createdAt }`. Role advertiser, email `test-<hex>@test.advault.invalid`, random unknown password (cannot log in; `/auth/login` also refuses). 409 `too_many_test_customers` past 50. |
| POST | `/test-customers/:id/switch` | `{ refreshToken? }` → `{ accessToken, refreshToken }` for the test customer (access token carries `testOwner: <adminId>`). The presented refresh token's session is ended. **404** `test_customer_not_found` unless it is the caller's (owner's) own. |
| POST | `/test-customers/back` | `{ refreshToken? }` → the admin's token pair. Only from a session whose `testOwner` claim matches the row's `test_owner_id` and whose owner is still an admin; **403** `not_in_test_customer` otherwise. |

A test customer is always test mode (`lib/testMode`: $0.50 charges tagged `test_mode=1`), its launch is forced to `validateOnly` (response adds `testCustomer: true`), its Google account / Mercury card / ops alerts are named `TEST · <name>`, Stripe gets no `customer_email`, and it is left out of revenue (`/metrics`, `/admin/ad-production`, `/admin/business`). `/auth/me` returns `isTestCustomer`. `/auth/refresh` keeps the claim, and refuses once the owner is no longer an admin.

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

## Internal: SiteVault (shared 3PandaLabs account)

Server to server from the SiteVault Worker, bearer `SITEVAULT_INTERNAL_TOKEN`
(= the Worker's `INTERNAL_TOKEN`), over the DNS-only `api-internal` host.
401 without it. `users` is the one account store for AdVault and SiteVault
(`routes/sitevaultAuth.ts`, `lib/sharedAccount`, migration 0025).

| Method | Path | Notes |
|---|---|---|
| POST | `/internal/sitevault/verify-login` | `{ email, password }` → `{ ok, userId, email }`; 401 `invalid_credentials` (same timing for unknown emails). |
| POST | `/internal/sitevault/accounts` | `{ email, password (8–200), createdAt?, sitevaultUsedAt? }` (ISO). **201** `{ ok, userId, email }`, a new user with `signup_app = 'sitevault'` (bcrypt, like every account). **409** `email_exists` with the existing `userId`: nothing on that account changes, never its password. SiteVault links that id only after the person proved the SiteVault password for the same email (lazy move); a fresh sign-up is told to sign in. `createdAt` keeps an older SiteVault account's date; `sitevaultUsedAt` stamps its first website. Future times are clamped to now. |
| POST | `/internal/sitevault/usage` | `{ userId, at? }` → `{ ok }`: stamps `sitevault_first_used_at` (only fills NULL or moves earlier). 404 `not_found` for an unknown or deleted account. |

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
| POST | `/campaigns` | Creates a draft. Nothing chargeable. Optional `audienceFilters` `{ages?, genders?, parentalStatuses?, incomes?, languages?}` (null/absent = everyone; values in `lib/audience/policy.ts`) and, for real estate, `targetAddress` `{street, city, state, postalCode}` with `targetZipCodes: []`. **400** `housing_demographics_not_allowed` / `housing_zip_targeting_not_allowed` / `listing_address_required` / `zip_codes_required` with a `detail` sentence (US housing-ads policy: no age, gender, parental status or ZIP targeting; income and language allowed).  Real estate also takes `realty` `{adType: 'listing'|'agent'|'sold', price?, beds?, baths? (.5 steps), openHouse?: {date, start, end}}` (lib/realty): a listing ad names the street, price, beds/baths and open house; an agent ad promotes the agent and city. Optional `adSchedule` `{days, startHour, endHour} | null` (0037; null = every day, all day; sent at launch as AdSchedule criteria). Optional `runDays` `7 | 14 | null` (absent/null = always on; migration 0033): launch turns 7/14 into `endsOn` and Google's `Campaign.end_date_time`. **400** `claim_not_allowed` `{detail, phrase}` when `offerDetails` has a claim Google clearly forbids (`lib/categories/claims.ts`; PATCH checks it too when `offerDetails` or `businessCategory` changes). |
| GET | `/campaigns` | |
| GET | `/campaigns/:campaignId` | Includes creatives — what the dashboard polls. |
| PATCH | `/campaigns/:campaignId` | 409 `campaign_is_live`. Same targeting fields and 400s as POST, checked against the row as it would be after the patch. `runDays` (7/14/null) is changeable until the campaign exists at Google, then **409** `campaign_already_launched`; so are `audienceFilters` and `adSchedule` (use the targeting route below). |
| PUT | `/campaigns/:campaignId/targeting` | Owner only. `{audienceFilters?: {...} \| null, adSchedule?: {days: ["mon"..."sun"], startHour 0-23, endHour 1-24 (> start), extraWindows?: [{days, startHour, endHour}] (max 2, no overlap with another window on the same day)} \| null}` (strict, at least one; a field left out is left alone; schedule null or every day 0-24 = always) → `{campaign, appliedAtGoogle, changedAtGoogle?}`. The schedule is one AdSchedule campaign criterion per day (account time zone; unchanged days kept, others removed/created, `lib/schedule/policy.ts`, column `ad_schedule`, 0037). Before launch: saved on the row (launch sends it). Once a Google campaign exists (live or paused): applied at Google FIRST in one atomic mutate (`lib/googleAds/targeting.ts`: reads the ad group's Audience + language criteria, then updates the Audience's dimensions / creates and attaches one / removes the criterion for everyone, and diffs languages at the ad-group or campaign level), then saved with `google_audience_resource_name` (0036). No mutate when nothing changes. **400** `housing_demographics_not_allowed` (real estate: no age/gender/parental); **409** `ad_account_unavailable` / `ad_account_revoked`; **502** `google_ads_error` with `detail` (row unchanged, the old audience keeps serving). |
| DELETE | `/campaigns/:campaignId` | 409 `campaign_is_live` — deleting the row would not stop the spend. |
| GET | `/campaigns/:campaignId/before-after` | Owner only. `{allowed, pairs: [{beforeAssetId, afterAssetId, beforeKey, afterKey}], attestedAt}` (lib/beforeAfter). `allowed` = the category may show before & after (trades only). A deleted photo drops its pair. |
| PUT | `/campaigns/:campaignId/before-after` | Owner only, any status (never re-renders). Body `{pairs: [{beforeAssetId, afterAssetId}] (max 2), attested}`; `[]` removes them. **400** `before_after_not_for_category` / `before_after_attestation_required` / `before_after_same_photo` / `before_after_duplicate_photo` (with `detail`), `unknown_assets` (not the user's own photo). Stores `before_after`, `before_after_attested_at/by`. Used by the next ad made and by "Make me a website". |
| PUT | `/campaigns/:campaignId/offer` | Owner only, ANY status (2026-11-20). Body `{offerDetails (1-2000, trimmed), callToAction? (1-40)}` (strict) → `{campaign, liveAdUnchanged, warnings: [{id, level, phrase, reason}]}`. **400** `claim_not_allowed` `{detail, phrase}` when the text has a claim Google clearly forbids (today: a housing exclusion like "adults only" in a real-estate ad; `lib/categories/claims.ts`). Other risky claims save and come back as `warnings`. Saves the offer the next ad is written from. Never calls Google and never re-renders: a live ad keeps the text and video it launched with (`liveAdUnchanged: true`). Used by the season card (`lib/categories/seasons.ts`). |
| GET | `/campaigns/:campaignId/badges` | Owner only. `{options: BadgeId[], selection: {ids, licenseNumber?}, chips: string[], attestedAt}` (lib/categories/badges, 0039). `options` = the category's badges (e.g. auto: `ase_certified`; landscaping: `pesticide_license`; typed-in categories: the generic three). |
| PUT | `/campaigns/:campaignId/badges` | Owner only, any status (never re-renders, never touches Google). Body `{ids: BadgeId[], licenseNumber?, attested}` (strict); `[]` removes them. **400** `badge_not_for_category` / `badge_attestation_required` / `badge_license_number_required` / `badge_license_number_invalid` / `badge_too_many` (max 4) / `badge_duplicate` (with `detail`). Stores `badges`, `badges_attested_at/by`. The next ad made shows the chips on its end card and the script writer may use them. |
| GET | `/campaigns/:campaignId/extras` | Owner only. `{available: ("spotlight"\|"orderUrl"\|"makes"\|"neighborZips")[], extras}` (lib/categories/extras, 0040): restaurant = featured dish + order link, auto repair = makes, landscaping = existing-customer ZIPs; `[]` for others. |
| PUT | `/campaigns/:campaignId/extras` | Owner only, any status (never re-renders, never touches Google). Body `{spotlight?: {dish, price?, assetId?}, orderUrl?, makes?, neighborZips?}` (strict; trimmed, deduped, empty = none; replaces the whole object). **400** `extras_not_for_category` / `spotlight_dish_required` / `spotlight_too_long` / `order_url_invalid` / `makes_invalid` (max 12) / `neighbor_zips_invalid` (with `detail`), `unknown_assets` (dish photo not the user's own). The next ad made leads with the dish photo (max 5 photos), puts "Try our <dish> · <price>" or "We service Toyota · Honda" on the end card (`script.endCardLine`) and tells the writer. Pointing the ad at the order link or the ZIPs is a separate PATCH `/campaigns/:id` (`landingUrl` / `targetZipCodes`, before launch only). |
| GET | `/campaigns/:campaignId/metrics?days=7` | Owner only. `{launched, days, since, currency, note, totals, daily[], lastSyncedAt}`. `days` 1–90 (default 7). Each summary: `impressions, views, clicks, spendMinor, spendDisplay, costPerViewMinor, costPerViewDisplay, ctr, viewRate` (rates 0..1, null with no denominator). Reads `campaign_daily_metrics`, never Google; `totals` is null before launch. |
| GET | `/campaigns/:campaignId/results?range=7d\|30d\|all` | Owner only (404 otherwise). "How your ad is doing" (2026-11-19). Before launch `{campaignId, launched: false, range}`. After: `{launched: true, range, since, currency, note, totals, balance, trend[], breakdowns, lastSyncedAt}`. `totals` = the metrics summary plus `costMicros`, `costPerClickMinor/Display` (null with no clicks); null when nothing is reported. `balance` (platform billing only, else null) = wallet `{balanceMinor, display, daysLeft}`, days left at the last 7 days' average daily spend (daily budget before any spend). `trend` = per day `{date, views, clicks, spendMinor, costPerViewMinor}`. `breakdowns.{age, gender, device, network, location, hour, dayOfWeek}` = `[{segment, label, share, impressions, views, clicks, spendMinor, ...}]` or **null when Google reported nothing** (UI: "Not enough views yet"). `location` = top 5 ZIPs, else cities. `all` starts at `launched_at`. `suggestions` (2026-11-20, `lib/adMetrics/suggestions.ts`) = up to 2 `{id, dimension: age\|gender\|dayOfWeek\|hour, metric: click\|view, label, message, question, action, apply, reachWarning}`; `apply` is the body for `PUT /campaigns/:id/targeting` (age/gender narrow `audienceFilters`, keeping the rest and Google's unknown group; weekdays/weekends or a morning/afternoon/evening block set `adSchedule`). Usually `[]`. Reads `campaign_daily_metrics` + `campaign_segment_metrics` (0035), never Google. |

## Admin analytics

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/admin/metrics?days=7` | admin session, or `ADMIN_ANALYTICS_TOKEN` bearer | Every launched campaign (live + paused) with business name, owner email, status, currency, Google customer id and the same totals summary; plus `totals` keyed by currency (never summed across currencies). The token is for a server-side caller such as the org admin site's Worker; unset = admin sessions only. Deliberately NOT `METRICS_TOKEN` — this names businesses and their spend. |
| GET | `/admin/ad-production?since=YYYY-MM-DD&until=YYYY-MM-DD` | admin session, or `ADMIN_ANALYTICS_TOKEN` bearer | Counts only, for the org admin site's cost per ad: `adsMade` (generations: distinct campaign + minute of AdVault-made creatives), `renders` (AdVault-made creatives, one per format, redos included), `paidAds` ($10 `new_ad` orders paid; not admins, test customers or internal accounts), `internalPaidAds` (the same, internal accounts only). `until` exclusive. |
| GET | `/admin/internal-spend?since=YYYY-MM-DD&until=YYYY-MM-DD` | admin session, or `ADMIN_ANALYTICS_TOKEN` bearer | Internal accounts (0032) only, for the org admin site's "Internal" tab. `{since, until, accounts: [{label, email, currency, paid: {adBudgetMinor, adsMinor, websiteMinor, siteOfferMinor, videoBundleMinor, planMinor, otherMinor, feesMinor, totalMinor}, planFromWalletMinor, adSpendMinor, campaignsWithSpend, launchedCampaigns, adsMade}]}`. `adBudgetMinor` = paid `payments` top-ups (by `updated_at`); ad/website/offer/bundle = paid purchases by sku (`paid_at`); `planMinor` = plan invoices paid with their own charge (an external `subinv:<id>` top-up credit exists), `planFromWalletMinor` = plan invoices drawn from the ad budget (no separate charge; already inside `adBudgetMinor`); `otherMinor` = `creation_fee` payments. `adSpendMinor` = Google-reported cost from `campaign_daily_metrics` on days in the range (synced hourly, any billing mode). No user ids. `until` exclusive. |
| GET | `/admin/recent-renders?limit=10` | admin session, or `ADMIN_ANALYTICS_TOKEN` bearer | The last renders (1–50): business, format, status/error, and `renderInfo` (engine template/ffmpeg, motion provider, clips made and reused, voice source) plus the script's sticker and people/portrait marks. Ops diagnostics without container logs. |

## Creatives

| Method | Path | Notes |
|---|---|---|
| — | (launch) | `POST /campaigns/:id/launch` (and `/resume`) answer **402 `plan_required`** `{firstMonthIncluded, detail}` when no plan covers now and none could be restarted off-session (see "The $19 plan follows the running ad" below), **402 `plan_pending`** while a just-paid plan checkout's webhook is in flight, **402 `plan_has_no_ads`** on the offer line. Admins (not in test mode) and at_cost accounts are exempt; skipped on `validateOnly`. |
| POST | `/campaigns/:campaignId/creatives/generate` | **202.** Writes the scripts, queues the renders, returns. One creative per requested aspect ratio. **402 `new_ad_payment_required`** (`{display, rendersPerAd}`) for any advertiser (not admin / `at_cost`) whose campaign has no paid `new_ad` with renders left. Spends one of the paid ad's `RENDERS_PER_AD` (3: first + 2 redos, `purchases.renders_used`), given back if generation is refused. No free first ad since 2026-11-13. |
| GET | `/new-ad/quote` | `{required, display, redosLeft}` (on the campaign route; `redosLeft` null when not metered): does this user pay per ad (everyone but admins and `at_cost`), and how much. |
| GET | `/campaigns/:campaignId/new-ad` | `{required, display, order, siteOffer}`: the campaign's latest new-ad order. `siteOffer` (offer combo, `lib/siteOffer`) is `{offered: paid|credit|free, offer, credits, addonDisplay}` when the campaign's link is a SiteVault site with offer text and SiteVault's `offer-status` answered (site live or in grace), else null (hide the box). |
| POST | `/webhooks/stripe` | **The only Stripe endpoint to register.** Routes each event to the payments / purchases / subscriptions handler (which verify the signature); 200 `ignored` for other apps on the shared account and unwanted events. See infra/stripe-setup.md. |
| POST | `/campaigns/:campaignId/new-ad/order` | Opens a $10 checkout. Body `{assetIds, aspectRatios}` is saved on the order; omit it to reuse the last order's. Optional `siteOffer: true` (offer combo): the mode is re-decided from SiteVault's live `offer-status` (`siteOfferQuote`); `paid` adds a second $2 line item "Offer on your website" (`SITE_OFFER_ADDON`, US only) and the order's `amount_minor` is the total; `credit` / `free` add nothing. Recorded in `purchases.site_offer_*` (migration 0023); 409 `site_offer_unavailable` when SiteVault is unreachable or the site can't take it. After the webhook marks it paid, the offer is pushed to SiteVault `POST /api/internal/sites/<slug>/offer` (`payment` advault for paid/free, credit for credit, `ref` = purchase id) without blocking the webhook; failures go to `site_offer_error` and the API's 10-minute sweep retries (max 5 attempts). 409 `ad_included_in_plan` (admin / `at_cost`) / `already_paid` (a paid ad not made yet, or made with renders left) / `campaign_is_live`. Paid via the shared `/webhooks/purchases/:provider`. |
| POST | `/campaigns/:campaignId/site-offer` | Offer combo for admins / `at_cost` (402 `buy_with_new_ad` for everyone else): puts the campaign's offer on its SiteVault site free, as a $0 `sku = 'site_offer'` purchase row (mode `free`), pushed inline. `{purchaseId, pushed}`; 409 `site_offer_unavailable`. `GET /campaigns/:campaignId/website` now also returns `siteOffer: {outcome: updated|pending|retrying|failed, offer} | null` for the latest paid website offer. |
| GET | `/campaigns/:campaignId/website` | `{ siteUrl, editUrl, … }`. `editUrl` is the stored (encrypted) SiteVault edit link when AdVault made the site, else for any SiteVault link SiteVault's key-less `/edit/<slug>`, which signs the owner in with the shared account. No link yet: `accountSite: { siteUrl, state }` when the account already has a website (another campaign's, else **one built on SiteVault**, from SiteVault `GET /api/internal/account-site`; `state` null for ours, SiteVault's `siteState` otherwise), never with `websiteFee`; else `websiteFee` (null = free). Unpaid: `pendingSite`. SiteVault down or without the lookup = no `accountSite` from it (behaviour before 2026-11-16). |
| POST | `/campaigns/:campaignId/website/use-existing` | Links the account's website (see `accountSite`) as `landing_url`, plus its encrypted edit link when AdVault made it (none for a SiteVault-built one). 404 `no_account_website`; **409** `account_website_not_live` (`detail` = its link) for a SiteVault-built site that isn't published there; 409 `campaign_is_live`. |
| POST | `/campaigns/:campaignId/website` | "Make me a website" (`{ phone, city, hours?, slug?, attest: true }`). 409 `website_exists` / `website_payment_pending` / `campaign_is_live`; **409 `website_exists_for_account`** (`detail` = the site) when the account has one here or on SiteVault, checked before anything is made or charged, and also when SiteVault's create answers 409 `account_has_site` (no site made, no $10 checkout). 400 `website_invalid`, 502 `website_builder_failed`. |
| POST | `/campaigns/:campaignId/website/account-site/delete` | **Admins only, REAL role** (`requireAdmin` + `users.role`; works in "Test as customer", 403 `admin_role_required` for everyone else). Optional `{ siteUrl }` = the link the card showed (409 `account_website_changed` if the account's site is now another). Deletes the account's website (`accountSite`, else a made-but-unpaid one on another campaign) on SiteVault for good (`DELETE /api/internal/sites/<slug>`), then clears `landing_url` / `sitevault_edit_enc` / `site_video_*` / `sitevault_pending_url` on the account's not-launched campaigns that link it and stops pending website/offer sweeps for it. `{ deleted, slug, unlinkedCampaigns }`. 404 `no_account_website`; 409 `campaign_is_live`, `website_in_use_by_launched_campaign` (`detail` = campaign name), `website_has_subscription`, `website_not_your_site`; 502 `website_delete_failed`. `GET .../website` returns `adminCanDelete` / `adminCanMakeAnother` for real admins. |
| GET | `/campaigns/:campaignId/website/ready` | owner | `{ ready }`: true once SiteVault reports the site live (or in grace) AND the page loads (6 s timeout); a non-SiteVault link is always ready. The website card polls it every 4 s and shows a "Building your website…" bar instead of the link until ready (gives up after ~3 min). |
| POST | `/new-ad/orders/:purchaseId/generate` | Spends a paid order: generates from its saved choices, marks it delivered with `renders_used = 1`. 409 `payment_pending` / `in_progress`; 200 `alreadyGenerated`. |
| GET | `/campaigns/:campaignId/creatives` | |
| PATCH | `/creatives/:creativeId/script` | Hand-edited copy, re-validated against the generator's own schema. Re-queues the render, spending one render (402 `new_ad_payment_required` when none left). 409 `creative_is_upload` for uploaded videos. |
| POST | `/campaigns/:campaignId/creatives/redo` | "Make it again": new script + render from the latest generation's photos, people/portrait marks and formats, **replacing** the previous AdVault-made creatives (launch uses every ready one; uploads stay). Spends one redo (402 `new_ad_payment_required` when none left; a paid new version via `/new-ad/order` also replaces). 409 `campaign_is_live` / `nothing_to_redo` / `already_rendering` / `photos_deleted`. |
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
| GET | `/admin/users?q=` | admin session only (role re-read from the database; never the token) | `{users[]}`: live accounts, admins first then newest, max 50; `q` matches email, name or business. Each: id, email, displayName, businessName, role, signupApp, createdAt. Page: `/dashboard/admin/users`. |
| POST | `/admin/users/:id/role` | same | Body `{role:'admin'|'advertiser'}`. 409 `own_role` (can't change your own), `last_admin` (never removes the last admin), `deleted_user`, `same_role`; 404 `not_found`. Serialised by an advisory lock. Applies at the user's next sign-in or token refresh. Rules: `lib/adminUsers/policy.ts`. |
| GET | `/admin/internal-accounts` | same | `{users[]}` (same shape as `/admin/users`, plus `isInternal`, `internalLabel`): live accounts with `users.is_internal` (0032). |
| POST | `/admin/internal-accounts` | same | Body `{email, internal: boolean, label?}` (email case-insensitive, label ≤60). Marks / unmarks 3PandaLabs' own account; unmarking clears the label. 404 `not_found`, 409 `test_customer`. Changes NO price, gate or launch: only revenue reporting, Stripe `internal=1` metadata and "INTERNAL · " names. Page: `/dashboard/admin/users` ("Internal accounts"). |

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
| GET | `/wallet` | The ad budget: `{ balanceMinor, currencyCode, display, budget, entries }`. `budget` (2026-11-19, `lib/wallet/runway.ts`) drives the dashboard / campaign-page banners from live and paused-for-funds **platform-billed** campaigns: `{ state: idle\|ok\|low\|empty, daysLeft, liveDailyMinor, liveCampaignIds, pausedForFunds: [{id,name}] }`. `daysLeft` = floor(balance / sum of live daily budgets), at least 1 while money is left; `low` = under max(2 days, $10); `empty` = a campaign is paused because the budget ran out. |
| POST | `/wallet/topup` | Opens a top-up checkout. Body `{ amountMinor, purpose?, campaignId? }`; with the caller's own `campaignId`, checkout returns to that campaign page instead of `/dashboard/wallet`. The UI offers $35 / $50 / $100 / custom. **400** `topup_below_minimum` `{minMinor, currencyCode, detail}` for a `topup` under $35 / ₹2,000 (`minTopupMinor`, the first preset; since 2026-11-20 server side, was UI only), checked on the REQUESTED amount before test mode charges 50 cents; `creation_fee` is exempt. On the paid webhook the card unfreezes and `resumeFundedCampaigns` (lib/billing/resume.ts, not awaited) re-enables at Google every campaign the empty wallet paused (`paused_for_funds_at`) that the balance again covers for 3 days (MIN_FUNDED_DAYS); the renderer's hourly spend sync retries. Campaigns paused for any other reason are never touched. |

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

## The $19 plan follows the running ad (2026-11-19, migration 0038, `lib/planBilling`)

"$19 a month while your ad is running. Pause anytime: no fee while paused." First month included with the first ad, once per account.

| Method | Path | Notes |
|---|---|---|
| POST | `/subscription` | Body `{ planKey, campaignId? }`. With `campaignId` (the caller's own; else 404) checkout returns to that campaign page (`?subscribed=1`). For `us-evergreen` when `users.plan_first_month_used_at` is NULL: **the included month**, a Stripe trial (`subscription_data[trial_end]` = the first period's end), $0 invoice, `subscriptions.first_month_included`/`included_until`; the response has `firstMonthIncluded: true`. Paying that $0 invoice (webhook) sets `plan_first_month_used_at` (once). An open but unpaid (`pending`) plan is replaced (its checkout session expired) instead of 409 `already_subscribed`. |
| GET | `/subscription` | Adds `plan: {firstMonthAvailable, adRunning}` and `subscription.includedUntil` (only while the included month lasts). |
| POST | `/subscription/cancel` | **409 `plan_follows_ads`** for the $19 plan while an ad runs (the sync would undo it; pausing the ad is how to stop paying). |
| POST | `/campaigns/:campaignId/pause` | Owner. Pauses a launched, live campaign at Google (status PAUSED via the MCC; managed accounts only, else 409 `ad_account_unavailable`), sets `status = 'paused'`, syncs the card limit, then `syncPlanBillingForUser`: with no other ad running the plan stops at the end of its paid period. `{campaign, plan}`. 409 `not_running`; 502 `google_ads_error` (row unchanged). Already paused = 200 `alreadyPaused`. |
| POST | `/campaigns/:campaignId/resume` | Owner. Re-enables a paused launched campaign: 409 `campaign_ended` past `ends_on`, 402 `insufficient_funds` (platform accounts, same 3-day rule as launch), then the plan gate (`ensurePlanForRunning`: a stopping plan inside its period passes and is un-stopped, no charge; a plan whose period is over is restarted off-session with the saved card; else 402 `plan_required`), then ENABLED at Google, `status = 'live'` (clears `paused_for_funds_at`), sync. `{campaign, plan, planRestarted}`. Already live = 200 `alreadyRunning`. |

How it maps to Stripe (`lib/planBilling/index.ts`, pure rules in `policy.ts`):
- **Running** = `status = 'live'` AND a Google campaign AND `ends_on` NULL or >= today (UTC). Paused for any reason, ended by its end date, or never launched = not running. No Google call.
- **No ad running** → `cancel_at_period_end=true` on the Stripe subscription (and locally). The paid period is served out; Stripe then ends it (`customer.subscription.deleted` → `canceled`).
- **An ad runs again inside the paid period** → `cancel_at_period_end=false`. No charge.
- **An ad runs after the period ended** → a NEW Stripe subscription on the same customer with the previous plan's card (`payment_behavior=error_if_incomplete`, charged now, same metadata/test/internal tags; test mode uses an inline 50-cent price on the previous product), recorded paid immediately with the same `stripe:in_…` ref the webhook later brings. No saved card / decline → 402 `plan_required` (checkout).
- `syncPlanBillingForUser(userId)` is the one function: called after launch, pause, resume, a plan payment, and a top-up that restarted an ad (`resumeAfterTopUp`), and by an API sweep every 10 minutes for everyone with a live plan or live campaign (covers the renderer's own changes: empty-budget pauses, end dates, hourly auto-restart; the renderer has no Stripe key). The renderer's auto-restart only switches an ad back on when a plan covers now (`planAllowsRunningFor`).
- Stripe's first payment arrives twice (`checkout.session.completed` and `invoice.paid` with `billing_reason: subscription_create`); the second copy is a duplicate (`firstPayment`), never month two (before 0038 it opened and paid month two). `sub_`/`cus_` ids are stored from either (`provider_subscription_ref`/`provider_customer_ref`; older rows resolve them from the `cs_` session on first use). `parent.subscription_details` (Stripe API 2025-03-31+) is read too.
- The $19 fee is always externally funded (`feeFunding('evergreen', *) = external`): it never draws on the ad budget.
- Account deletion also cancels the Stripe plan immediately.

## Launch

| Method | Path | Notes |
|---|---|---|
| POST | `/campaigns/:campaignId/launch` | **The only route in this codebase that spends money.** Body `{ adAccountId, validateOnly?, videoOnWebsite? }`. `videoOnWebsite` (default true, SiteVault sites only) sets `campaigns.site_video_wanted`; after a real launch the ad video is pushed to SiteVault `POST /api/internal/sites/<slug>/video` without being awaited (`lib/siteVideo`, API sweep retries every 10 minutes, up to 5 attempts). Builds a **Demand Gen** campaign in one atomic Google request: PAUSED for customer-billed and BYO accounts, ENABLED for platform-billed ones (the customer has no Google access to switch it on). `validateOnly: true` is a dry run: Google checks everything, nothing is created, and the billing and wallet gates are skipped. Re-checks the targeting rules first (**409** with the same codes as POST `/campaigns`, dry run included). Demographic filters become one `Audience` (age/gender/parental/income dimensions) attached to the ad group (`audienceSetting.useAudienceGrouped`); languages are `language` criteria. Real estate targets a `proximity` campaign criterion around `targetAddress` (campaign created with `demandGenCampaignSettings.upgradedTargeting: false`). Response adds `radiusMilesAroundAddress` (null for ZIP campaigns) and `audienceFiltersApplied`. A real-estate listing ad with an open house ends on the open-house day (Google `end_date_time`, the earlier of that and the run length; `lib/realty`), and **409** `open_house_over` once that day has passed (UTC, dry run included). |

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
lists Google's per-field reasons), `budget_below_minimum` (409, with
`minDailyBudgetMinor`, `currencyCode` and a plain `detail`).

`budget_below_minimum` is checked right after `already_launched`, dry run
included, against the currency's floor (`minDailyBudgetMinorFor` in
`lib/pricing`: **$5/day USD**, Google's Demand Gen per-day minimum; ₹100/day
INR). Campaigns saved while the floor was $1 (2026-11-10 to 2026-11-19) hit it;
PATCH `dailyBudgetCents` fixes them (POST/PATCH `/campaigns` refuse a budget
under the floor, PATCH with 400 `budget_below_minimum`). Google's own
`BUDGET_BELOW_PER_DAY_MINIMUM` is mapped to the same 409 (with Google's
minimum), and the campaign is not marked failed.

Run length (migration 0033): a campaign with `run_days` 7 or 14 gets
`endDateTime: "<last day> 23:59:59"` on the Demand Gen campaign create
(`end_date_time`, which replaced the date-only `end_date` in v23; account time
zone). The last day is today's UTC date + run_days - 1 (`runEndDate` in
`lib/pricing`), stored as `campaigns.ends_on`; Google stops the campaign by
itself. `run_days` NULL sends no end date (always on). The daily budget is
unchanged either way.

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

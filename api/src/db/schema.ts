import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { BillingMode } from "../lib/billing/policy.js";

// Enum-ish columns are `text` + a CHECK constraint rather than pgEnum, matching
// the RentVault and RsvpVault schemas. Adding a value to a pgEnum needs its own
// migration and can't run inside a transaction with other DDL; a CHECK is a
// one-line ALTER.

// ---------------------------------------------------------------------------
// Identity — advertisers. One row per business owner who signs in.
// ---------------------------------------------------------------------------

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull().unique(),
    passwordHash: text("password_hash").notNull(),
    // The person. `businessName` is what appears in generated ad copy.
    displayName: text("display_name"),
    businessName: text("business_name"),
    // Drives the AI script prompt's tone and the fallback template's phrasing —
    // a plumber's 15-second pre-roll reads nothing like a dentist's.
    businessCategory: text("business_category"),
    phone: text("phone"),
    // "admin" sees the internal ops view; "advertiser" only ever sees own rows.
    role: text("role").notNull().default("advertiser"),

    // Market. Drives currency, plan and the Google Ads child account's own
    // currency — which is IMMUTABLE at Google once the account exists, so this
    // is effectively permanent from first provisioning.
    countryCode: text("country_code").notNull().default("US"),
    currencyCode: text("currency_code").notNull().default("USD"),
    // 'standard' charges a platform fee; 'at_cost' passes Google's cost through
    // at 0% margin. A real mode, not a coupon — see lib/pricing.
    marginMode: text("margin_mode").notNull().default("standard"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("users_role_check", sql`${t.role} in ('advertiser','admin')`),
    check("users_currency_check", sql`${t.currencyCode} in ('INR','USD')`),
    check("users_margin_mode_check", sql`${t.marginMode} in ('standard','at_cost')`),
  ],
);

// Revocable refresh tokens. Only the bcrypt hash is stored, so a DB leak alone
// doesn't yield usable tokens. Token format is `${sessionId}.${secret}` — see
// auth/jwt.ts for why the id is carried in the token.
export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    refreshTokenHash: text("refresh_token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_sessions_user").on(t.userId)],
);

// ---------------------------------------------------------------------------
// Google Ads accounts. Two shapes live in this table, distinguished by
// `isManaged`:
//
//   isManaged = true  — a CHILD account AdVault created under the 3PandaLabs
//                       MCC via CustomerService.CreateCustomerClient. The
//                       advertiser never sees Google Ads. Billing sits on the
//                       MCC, which is why the wallet guard in lib/wallet exists
//                       at all: the org fronts this spend.
//   isManaged = false — the advertiser's OWN account, connected by OAuth. Zero
//                       org liability. Retained deliberately: some advertisers
//                       already run Google Ads and will not hand that over, and
//                       the code path is already built and tested.
//
// `refreshTokenCiphertext` is AES-256-GCM output from lib/crypto.ts, never a
// usable token — a database dump alone does not hand the reader an ad account.
// It is NULL for managed accounts, which need no per-user grant: the MCC's own
// credentials reach them.
// ---------------------------------------------------------------------------

export const adAccounts = pgTable(
  "ad_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Only 'google_ads' today. Present so a second network (Meta, TikTok)
    // doesn't need a table rename.
    provider: text("provider").notNull().default("google_ads"),

    // The advertiser's own Google Ads customer id, digits only, no dashes —
    // dashes are display formatting and the API rejects them.
    customerId: text("customer_id").notNull(),
    descriptiveName: text("descriptive_name"),
    currencyCode: text("currency_code"),
    timeZone: text("time_zone"),
    // Set when the customer is reached through a Manager (MCC) account, which
    // is the normal shape for an agency-style tool. Sent as login-customer-id.
    loginCustomerId: text("login_customer_id"),
    // Google refuses mutate operations against a test account with a
    // production developer token and vice versa; knowing which this is turns a
    // confusing API error into a clear one at launch time.
    isTestAccount: text("is_test_account").notNull().default("unknown"),

    // Null for managed (MCC child) accounts — see the note above.
    refreshTokenCiphertext: text("refresh_token_ciphertext"),
    scope: text("scope"),

    // --- MCC-managed accounts -----------------------------------------------
    isManaged: boolean("is_managed").notNull().default(false),
    // The MCC this child hangs off. Recorded per-row rather than read from env
    // at query time, so a future MCC migration doesn't silently reinterpret
    // historical rows.
    managerCustomerId: text("manager_customer_id"),
    // pending -> active | failed. Provisioning is an API round trip that can
    // fail (quota, unapproved developer token, currency mismatch), and the
    // advertiser must see why rather than an empty dashboard.
    provisionStatus: text("provision_status"),
    provisionError: text("provision_error"),
    provisionedAt: timestamp("provisioned_at", { withTimezone: true }),

    // --- Who pays Google ----------------------------------------------------
    // Orthogonal to isManaged, which only says whether *we* provisioned the
    // account under our MCC. This says whose card Google charges:
    //
    //   'platform' — our MCC payments account backs the child. We front the
    //                spend and recover it from the prepaid wallet. Only legal
    //                when isManaged, and it is the only mode spendSync touches.
    //   'customer' — the advertiser's own payment profile. We carry no float
    //                and no chargeback exposure on ad spend.
    //
    // A brought-your-own-account connection (isManaged = false) is always
    // 'customer' by construction — we could not bill it if we wanted to.
    billingMode: text("billing_mode").$type<BillingMode>().notNull().default("customer"),

    // Only meaningful for isManaged + 'customer': the child exists under our
    // MCC but the advertiser has to accept an account invitation and then enter
    // a card in Google's own UI, because the Ads API has no method that adds a
    // payment instrument. Until this reaches 'active' the account cannot spend,
    // so launch must refuse rather than create a campaign that will never serve.
    //
    // null -> pending -> invited -> active
    //                          \-> failed
    billingLinkStatus: text("billing_link_status").$type<
      "pending" | "invited" | "active" | "failed"
    >(),
    billingInvitationResourceName: text("billing_invitation_resource_name"),
    billingInvitedAt: timestamp("billing_invited_at", { withTimezone: true }),
    billingConfirmedAt: timestamp("billing_confirmed_at", { withTimezone: true }),
    billingCheckedAt: timestamp("billing_checked_at", { withTimezone: true }),
    // Which MCC payments account was attached in 'platform' mode. Recorded for
    // the same reason as managerCustomerId: a future billing migration must not
    // silently reinterpret historical rows.
    billingPaymentsAccountId: text("billing_payments_account_id"),

    // 'active' | 'revoked' — set to 'revoked' when Google answers
    // invalid_grant, so the dashboard can prompt a reconnect instead of
    // failing every launch with the same opaque error.
    status: text("status").notNull().default("active"),
    lastRefreshedAt: timestamp("last_refreshed_at", { withTimezone: true }),
    connectedAt: timestamp("connected_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_ad_accounts_user").on(t.userId),
    // One row per (user, provider, customer). Reconnecting the same account
    // updates the ciphertext rather than accumulating stale tokens — each of
    // which would otherwise remain independently usable.
    uniqueIndex("uq_ad_accounts_user_provider_customer").on(t.userId, t.provider, t.customerId),
    check("ad_accounts_provider_check", sql`${t.provider} in ('google_ads')`),
    check("ad_accounts_status_check", sql`${t.status} in ('active','revoked')`),
    check(
      "ad_accounts_provision_status_check",
      sql`${t.provisionStatus} is null or ${t.provisionStatus} in ('pending','active','failed')`,
    ),
    // The invariant that keeps the two shapes from blurring: an unmanaged
    // account is useless without its OAuth grant, and a managed one must never
    // pretend to have a per-user token it does not have.
    check(
      "ad_accounts_managed_token_check",
      sql`(${t.isManaged} = true and ${t.refreshTokenCiphertext} is null)
          or (${t.isManaged} = false and ${t.refreshTokenCiphertext} is not null)`,
    ),
    check("ad_accounts_billing_mode_check", sql`${t.billingMode} in ('platform','customer')`),
    // We can only put our own payments account behind an account we provisioned.
    // Without this an operator could flip a brought-your-own connection to
    // 'platform' and the wallet would start absorbing someone else's spend.
    check(
      "ad_accounts_platform_billing_managed_check",
      sql`${t.billingMode} = 'customer' or ${t.isManaged} = true`,
    ),
    check(
      "ad_accounts_billing_link_status_check",
      sql`${t.billingLinkStatus} is null
          or ${t.billingLinkStatus} in ('pending','invited','active','failed')`,
    ),
    // The invitation handshake only exists for managed accounts the customer
    // pays for. Platform-billed and BYO accounts must leave it null so the
    // launch guard can read it as "not applicable" rather than "not done".
    check(
      "ad_accounts_billing_link_applicability_check",
      sql`${t.billingLinkStatus} is null
          or (${t.isManaged} = true and ${t.billingMode} = 'customer')`,
    ),
    check("ad_accounts_test_check", sql`${t.isTestAccount} in ('yes','no','unknown')`),
    // Digits only. A customer id with dashes reaches Google as a 400 that reads
    // like an auth failure.
    check("ad_accounts_customer_id_check", sql`${t.customerId} ~ '^[0-9]{5,20}$'`),
  ],
);

// ---------------------------------------------------------------------------
// Money.
//
// Under the MCC model the org's payment method backs every child account, so
// 3PandaLabs pays Google FIRST and recovers from the advertiser afterwards.
// These three tables are what bounds that exposure: an advertiser must hold a
// positive prepaid balance for a campaign to be live, and the nightly spend
// sync pauses campaigns at Google the moment it hits zero. Worst case the org
// is out roughly one day of that advertiser's daily budget — not a month of
// uncapped spend.
//
// Every amount is an INTEGER in the currency's minor unit. Never a float.
// ---------------------------------------------------------------------------

export const wallets = pgTable(
  "wallets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" })
      .unique(),
    // Denormalised running total. The ledger is the source of truth; this is
    // the value the launch guard reads on every request, and recomputing it
    // from the ledger each time would put an aggregate on the hot path.
    // lib/wallet/index.ts is the ONLY thing allowed to write it, always in the
    // same transaction as the ledger row.
    balanceMinor: integer("balance_minor").notNull().default(0),
    currencyCode: text("currency_code").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("wallets_currency_check", sql`${t.currencyCode} in ('INR','USD')`),
    // A negative balance means the org is out of pocket beyond what it agreed
    // to float. It should be impossible; the constraint is here so that if a
    // bug ever makes it possible, the write fails loudly instead of quietly
    // financing someone's ad spend.
    check("wallets_balance_non_negative", sql`${t.balanceMinor} >= 0`),
  ],
);

// Append-only. Nothing updates or deletes a ledger row — a correction is a new
// row of type 'adjustment'. This is what makes the balance auditable and what
// lets a disputed charge be reconstructed months later.
export const ledgerEntries = pgTable(
  "ledger_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    walletId: uuid("wallet_id")
      .notNull()
      .references(() => wallets.id, { onDelete: "cascade" }),
    // topup      — advertiser paid us (credit, positive)
    // spend      — Google charged the child account (debit, negative)
    // fee        — AdVault creation/platform fee (debit, negative)
    // refund     — money returned (debit, negative)
    // adjustment — manual correction, either sign
    type: text("type").notNull(),
    // Signed: positive credits the wallet, negative debits it. Storing the sign
    // rather than a separate direction column means summing the column IS the
    // balance, with no case statement to get wrong.
    amountMinor: integer("amount_minor").notNull(),
    currencyCode: text("currency_code").notNull(),
    description: text("description"),
    // Which campaign a spend/fee relates to, when it relates to one.
    campaignId: uuid("campaign_id").references(() => campaigns.id, { onDelete: "set null" }),
    // Provider reference (Razorpay payment id, Stripe payment intent) or, for
    // spend rows, the Google date-segment key. Unique per wallet so a retried
    // webhook or a re-run spend sync cannot double-credit or double-debit.
    externalRef: text("external_ref"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_ledger_wallet").on(t.walletId, t.createdAt),
    uniqueIndex("uq_ledger_wallet_ref")
      .on(t.walletId, t.externalRef)
      .where(sql`external_ref is not null`),
    check(
      "ledger_type_check",
      sql`${t.type} in ('topup','spend','fee','refund','adjustment')`,
    ),
    check("ledger_currency_check", sql`${t.currencyCode} in ('INR','USD')`),
    // Sign must match intent, so a mis-signed spend can never credit a wallet.
    check(
      "ledger_sign_check",
      sql`(${t.type} = 'topup' and ${t.amountMinor} > 0)
          or (${t.type} in ('spend','fee','refund') and ${t.amountMinor} < 0)
          or (${t.type} = 'adjustment' and ${t.amountMinor} <> 0)`,
    ),
  ],
);

// Checkout attempts. Written before the advertiser is sent to the provider, so
// an abandoned checkout is visible rather than invisible, and a webhook that
// arrives for an unknown reference is a red flag rather than a silent credit.
export const payments = pgTable(
  "payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    // Provider's own id. Unique per provider — this is the idempotency key that
    // stops a replayed webhook crediting a wallet twice.
    providerRef: text("provider_ref"),
    amountMinor: integer("amount_minor").notNull(),
    currencyCode: text("currency_code").notNull(),
    // topup | creation_fee | subscription
    purpose: text("purpose").notNull(),
    // created -> paid | failed | cancelled
    status: text("status").notNull().default("created"),
    // Provider payload as received, for dispute reconstruction. Never trusted
    // as a source of truth — the signature check in lib/payments decides.
    providerPayload: jsonb("provider_payload"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_payments_user").on(t.userId, t.createdAt),
    uniqueIndex("uq_payments_provider_ref")
      .on(t.provider, t.providerRef)
      .where(sql`provider_ref is not null`),
    check("payments_provider_check", sql`${t.provider} in ('razorpay','stripe','manual')`),
    check("payments_currency_check", sql`${t.currencyCode} in ('INR','USD')`),
    check("payments_purpose_check", sql`${t.purpose} in ('topup','creation_fee','subscription')`),
    check("payments_status_check", sql`${t.status} in ('created','paid','failed','cancelled')`),
    check("payments_amount_check", sql`${t.amountMinor} > 0`),
  ],
);

// ---------------------------------------------------------------------------
// Source material — the storefront photos and logos an advertiser uploads.
// Objects live in R2; this table is the metadata and the ownership record.
// ---------------------------------------------------------------------------

export const assets = pgTable(
  "assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // 'photo' (storefront, team, work-in-progress) or 'logo'. The renderer
    // treats them differently: photos are Ken-Burns backdrops, a logo is
    // composited onto the end card without cropping.
    kind: text("kind").notNull().default("photo"),
    r2Key: text("r2_key").notNull().unique(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes"),
    originalFilename: text("original_filename"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_assets_user").on(t.userId),
    check("assets_kind_check", sql`${t.kind} in ('photo','logo')`),
  ],
);

// ---------------------------------------------------------------------------
// Campaigns — one row per geotargeted ad campaign.
//
// Money is stored in minor units as an integer. A float daily budget would
// accumulate representation error into something that is charged to a real
// card, and Google's own API takes micros for exactly this reason.
// ---------------------------------------------------------------------------

export const campaigns = pgTable(
  "campaigns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Nullable: a campaign is drafted, scripted and rendered before an ad
    // account is ever connected. Requiring it up front would put the OAuth
    // consent screen in front of a user who hasn't seen the product yet.
    adAccountId: uuid("ad_account_id").references(() => adAccounts.id, { onDelete: "set null" }),

    name: text("name").notNull(),
    businessName: text("business_name").notNull(),
    businessCategory: text("business_category").notNull(),
    // What the ad asks the viewer to do, and where it sends them.
    callToAction: text("call_to_action").notNull().default("Call now"),
    landingUrl: text("landing_url").notNull(),
    // Free-text context fed to the script generator ("family-run since 1998,
    // same-day emergency callouts"). Not shown to viewers directly.
    offerDetails: text("offer_details"),

    // Geotargeting. text[] rather than a join table: this is a short,
    // hand-entered list that is always read whole, never joined or aggregated.
    targetZipCodes: text("target_zip_codes").array().notNull(),
    radiusMiles: integer("radius_miles").notNull().default(10),

    dailyBudgetCents: integer("daily_budget_cents").notNull(),
    currencyCode: text("currency_code").notNull().default("USD"),

    // draft     — being built in the wizard
    // rendering — creatives queued or encoding
    // ready     — creatives rendered, not yet launched
    // live      — pushed to Google Ads and serving
    // paused    — paused at Google
    // failed    — launch rejected; see launchError
    status: text("status").notNull().default("draft"),

    // Populated only by POST /campaigns/:id/launch — the single place in this
    // codebase that spends money. Resource names are Google's own identifiers
    // ("customers/123/campaigns/456").
    googleCampaignResourceName: text("google_campaign_resource_name"),
    googleBudgetResourceName: text("google_budget_resource_name"),
    launchError: text("launch_error"),
    launchedAt: timestamp("launched_at", { withTimezone: true }),

    // Which Google customer this ran in. Denormalised from ad_accounts because
    // ad_accounts.id is ON DELETE SET NULL — a disconnected account must not
    // erase the record of where a live campaign's money went.
    googleCustomerId: text("google_customer_id"),

    // Spend recovered from Google by the nightly sync, in minor units. Drives
    // the wallet debit and the auto-pause. `lastSpendSyncedDate` is the last
    // Google *report date* consumed, not a timestamp — Google reports by day in
    // the account's timezone, and keying on a date is what makes the sync
    // idempotent when it re-runs.
    spendMinorToDate: integer("spend_minor_to_date").notNull().default(0),
    lastSpendSyncedDate: text("last_spend_synced_date"),
    // Set when the wallet ran dry and the sync paused it at Google, so the
    // dashboard can say why rather than showing an unexplained pause.
    pausedForFundsAt: timestamp("paused_for_funds_at", { withTimezone: true }),

    // When this month's offer stops being true.
    //
    // Local ads are OFFER ads — "30% off till Sunday", not "we exist". An offer
    // campaign still serving after its deadline is worse than no ad at all: it
    // burns budget and sends people to a shop that will turn them away. Nothing
    // in Google pauses on our behalf, so the sweep in render/offerCycles.ts
    // does, and `offerExpiredAt` records that it happened rather than leaving
    // another unexplained pause.
    offerExpiresAt: timestamp("offer_expires_at", { withTimezone: true }),
    offerExpiredAt: timestamp("offer_expired_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_campaigns_user").on(t.userId),
    index("idx_campaigns_status").on(t.status),
    check(
      "campaigns_status_check",
      sql`${t.status} in ('draft','rendering','ready','live','paused','failed')`,
    ),
    // A zero or negative daily budget would be accepted by this API and
    // rejected by Google with a much less obvious message.
    check("campaigns_budget_check", sql`${t.dailyBudgetCents} > 0`),
    // Google's radius targeting tops out well above this; the cap is a product
    // decision — past ~50 miles it stops being hyper-local advertising and
    // starts being an expensive way to reach people who will never visit.
    check("campaigns_radius_check", sql`${t.radiusMiles} between 1 and 50`),
    // An empty target list would silently become a nationwide campaign at
    // Google, which is the single most expensive way for this app to be wrong.
    check("campaigns_zips_check", sql`array_length(${t.targetZipCodes}, 1) between 1 and 50`),
  ],
);

// ---------------------------------------------------------------------------
// Creatives — one rendered video per aspect ratio.
//
// 16:9 is the YouTube in-stream/pre-roll slot; 9:16 is Shorts. They are
// separate rows rather than one row with two keys because they render, fail
// and get replaced independently.
// ---------------------------------------------------------------------------

export const creatives = pgTable(
  "creatives",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),

    aspectRatio: text("aspect_ratio").notNull(),

    // The generated script: { hook, body, cta, durationSeconds, scenes[] }.
    // jsonb rather than columns — it is written whole by the generator, read
    // whole by the renderer, and its shape will change more than once.
    script: jsonb("script"),
    // Whether the script came from the model or the deterministic fallback.
    // Worth knowing when the copy reads oddly: 'ai' | 'fallback'.
    scriptSource: text("script_source"),

    // Ordered R2 keys of the source assets this creative was built from,
    // snapshotted at generation time so deleting an asset later doesn't make an
    // already-rendered creative unexplainable.
    sourceAssetKeys: text("source_asset_keys").array().notNull().default(sql`'{}'::text[]`),

    // queued -> rendering -> ready | failed
    renderStatus: text("render_status").notNull().default("queued"),
    renderError: text("render_error"),

    videoKey: text("video_key"),
    thumbnailKey: text("thumbnail_key"),
    durationSeconds: integer("duration_seconds"),
    sizeBytes: integer("size_bytes"),

    // --- optional enrichment, each degrading to the still-image pipeline -----
    // R2 keys of AI-generated image-to-video clips, one per scene, index-aligned
    // with script.scenes. Empty when no motion provider is configured — the
    // renderer then falls back to the Ken Burns pan on the still, which is the
    // behaviour that shipped and works.
    motionClipKeys: text("motion_clip_keys").array().notNull().default(sql`'{}'::text[]`),
    // 'kling' | 'luma' | 'none'
    motionSource: text("motion_source").notNull().default("none"),
    // R2 key of the generated voiceover track. Null means a silent cut.
    voiceoverKey: text("voiceover_key"),
    // 'edge-tts' | 'elevenlabs' | 'none'
    voiceSource: text("voice_source").notNull().default("none"),

    // 'standard' — the subscription pipeline: the advertiser's photos, animated.
    // 'cinematic' — the paid add-on: text-to-video footage the model invented,
    //   closing on the advertiser's real photo. A different render path, a
    //   different cost per unit, and a different failure policy (a cinematic
    //   render that fails is a refund, not a downgraded ad), so the renderer has
    //   to be able to tell them apart before it starts.
    kind: text("kind").notNull().default("standard"),
    // The order that paid for this creative. Null for everything the
    // subscription produces.
    //
    // Declared without .references() on purpose: `purchases` is defined further
    // down this file, and a forward reference here would be evaluated before
    // that table exists. The foreign key is real — 0004 adds it in SQL — this
    // is only how it is spelled in the TypeScript.
    purchaseId: uuid("purchase_id"),

    // Set once uploaded to YouTube as part of a launch. Google Ads video ads
    // reference a YouTube video id, not an arbitrary MP4 URL — see
    // infra/google-ads-setup.md.
    youtubeVideoId: text("youtube_video_id"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    renderedAt: timestamp("rendered_at", { withTimezone: true }),
  },
  (t) => [
    index("idx_creatives_campaign").on(t.campaignId),
    check("creatives_aspect_check", sql`${t.aspectRatio} in ('16:9','9:16')`),
    check("creatives_motion_source_check", sql`${t.motionSource} in ('none','kling','luma')`),
    check("creatives_voice_source_check", sql`${t.voiceSource} in ('none','edge-tts','elevenlabs')`),
    check(
      "creatives_render_status_check",
      sql`${t.renderStatus} in ('queued','rendering','ready','failed')`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Render queue. A table rather than Redis/Temporal: the only async work in this
// app is "encode this creative", the API and renderer already share a database,
// and `FOR UPDATE SKIP LOCKED` is a correct multi-consumer queue.
//
// See src/render/jobs.ts. Do not replace the claim query with a plain
// SELECT + UPDATE — with two renderer replicas that encodes the same creative
// twice and the later PUT silently wins.
// ---------------------------------------------------------------------------

export const renderJobs = pgTable(
  "render_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    creativeId: uuid("creative_id")
      .notNull()
      .references(() => creatives.id, { onDelete: "cascade" }),

    // queued -> running -> done | failed
    status: text("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),

    // Identifies the container that holds the claim, so a job stuck in
    // 'running' can be traced to a specific replica in the Coolify logs.
    claimedBy: text("claimed_by"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    // Both the retry backoff and the crash-recovery mechanism: a job whose
    // worker died is picked up again once `runAfter` passes, without needing a
    // separate reaper process.
    runAfter: timestamp("run_after", { withTimezone: true }).notNull().defaultNow(),

    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The claim query's index: it filters on status + runAfter and orders by
    // runAfter. Without this the queue table-scans once it holds any history.
    index("idx_render_jobs_claim").on(t.status, t.runAfter),
    // One live job per creative. A double-enqueue (impatient user, retried
    // request) must not become two encodes of the same video.
    uniqueIndex("uq_render_jobs_creative_open")
      .on(t.creativeId)
      .where(sql`status in ('queued','running')`),
    check("render_jobs_status_check", sql`${t.status} in ('queued','running','done','failed')`),
  ],
);

// ---------------------------------------------------------------------------
// Subscriptions — the revenue model.
//
// Until this table existed, AdVault earned nothing at any customer count:
// `plan.monthlyFeeMinor` was 0 on every plan, no ledger row was ever written
// with type 'fee', and the only money that moved was ad spend passing straight
// through to Google. This is the row that makes a customer a paying customer.
//
// One live subscription per user (partial unique index below). Changing plan
// cancels and re-creates rather than mutating, so the invoice history always
// names the price it was actually charged at.
// ---------------------------------------------------------------------------

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    // Plan key from lib/pricing (in-offer, in-managed, us-offer, us-managed).
    planKey: text("plan_key").notNull(),
    // Denormalised from the plan so a later price-list edit cannot retroactively
    // change what an existing subscriber was sold.
    line: text("line").notNull(),
    currencyCode: text("currency_code").notNull(),
    // The fee agreed AT SIGNUP. Deliberately a copy: repricing the plan table
    // must never silently change an existing subscriber's bill. A price change
    // is a new subscription, not an UPDATE.
    amountMinor: integer("amount_minor").notNull(),

    // razorpay | stripe | paddle | manual. Which rail collects the money.
    // 'paddle' is the merchant-of-record path, where Paddle is the seller and
    // therefore carries the Indian GST/OIDAR obligation instead of us.
    provider: text("provider").notNull(),
    providerRef: text("provider_ref"),

    // pending  — created, first payment not yet confirmed
    // active   — paid and current
    // past_due — a charge failed; still serving, inside the grace window
    // canceled — ended deliberately
    // expired  — ended because dunning ran out
    status: text("status").notNull().default("pending"),

    currentPeriodStart: timestamp("current_period_start", { withTimezone: true }),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    // Cancel at the end of the paid period rather than immediately. Cutting
    // service off mid-period for someone who has already paid is a refund
    // problem we do not want.
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    canceledAt: timestamp("canceled_at", { withTimezone: true }),

    // Consecutive failed charges, reset to 0 on any success. Drives the dunning
    // ladder in lib/subscriptions.
    failedChargeCount: integer("failed_charge_count").notNull().default(0),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_subscriptions_user").on(t.userId),
    // Renewals are found by scanning for periods that have ended. Partial,
    // because canceled and expired rows are the majority over time and are
    // never due for anything.
    index("idx_subscriptions_due")
      .on(t.currentPeriodEnd)
      .where(sql`status in ('active','past_due')`),
    uniqueIndex("uq_subscriptions_provider_ref")
      .on(t.provider, t.providerRef)
      .where(sql`provider_ref is not null`),
    // At most one live subscription per user. Without this, a double-submitted
    // checkout bills someone twice a month forever and nothing notices.
    uniqueIndex("uq_subscriptions_one_live")
      .on(t.userId)
      .where(sql`status in ('pending','active','past_due')`),
    check("subscriptions_line_check", sql`${t.line} in ('offer','managed')`),
    check("subscriptions_currency_check", sql`${t.currencyCode} in ('INR','USD')`),
    check(
      "subscriptions_provider_check",
      sql`${t.provider} in ('razorpay','stripe','paddle','manual')`,
    ),
    check(
      "subscriptions_status_check",
      sql`${t.status} in ('pending','active','past_due','canceled','expired')`,
    ),
    // A zero-amount subscription is the bug this table exists to fix. at_cost
    // customers get no subscription row at all rather than a free one, so
    // "how many people pay us" is answerable by counting rows.
    check("subscriptions_amount_check", sql`${t.amountMinor} > 0`),
  ],
);

// One row per billing period per subscription. Written BEFORE the charge is
// attempted, so a failed period is visible rather than absent — the same reason
// `payments` rows precede the provider call.
export const subscriptionInvoices = pgTable(
  "subscription_invoices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subscriptionId: uuid("subscription_id")
      .notNull()
      .references(() => subscriptions.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    amountMinor: integer("amount_minor").notNull(),
    currencyCode: text("currency_code").notNull(),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),

    // pending | paid | failed | voided
    status: text("status").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    failureReason: text("failure_reason"),

    // Provider's invoice/payment id. Unique per subscription so a replayed
    // webhook cannot post the fee twice — the same guarantee the wallet's
    // (wallet_id, external_ref) index gives top-ups.
    externalRef: text("external_ref"),
    providerPayload: jsonb("provider_payload"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_sub_invoices_sub").on(t.subscriptionId, t.periodStart),
    index("idx_sub_invoices_user").on(t.userId),
    uniqueIndex("uq_sub_invoices_ref")
      .on(t.subscriptionId, t.externalRef)
      .where(sql`external_ref is not null`),
    // One invoice per period. Makes the renewal sweep safe to re-run: a second
    // pass for the same period is a caught duplicate, not a second charge.
    uniqueIndex("uq_sub_invoices_period").on(t.subscriptionId, t.periodStart),
    check("sub_invoices_currency_check", sql`${t.currencyCode} in ('INR','USD')`),
    check("sub_invoices_status_check", sql`${t.status} in ('pending','paid','failed','voided')`),
    check("sub_invoices_amount_check", sql`${t.amountMinor} > 0`),
    check("sub_invoices_period_check", sql`${t.periodEnd} > ${t.periodStart}`),
  ],
);

// ---------------------------------------------------------------------------
// Offer cycles — the monthly conversation.
//
// A local business does not advertise "we exist", it advertises "499 haircut
// till Sunday". The offer IS the ad, it changes every month, and that is what
// makes a monthly charge obvious to the customer: they are not buying a video
// subscription, they are buying this month's promotion going out.
//
// A shop owner will not log into a dashboard on the 1st of the month. They will
// reply to a WhatsApp message. So one row per subscription per month tracks
// that conversation: prompted -> answered -> previewed -> approved.
// ---------------------------------------------------------------------------

export const offerCycles = pgTable(
  "offer_cycles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    subscriptionId: uuid("subscription_id").references(() => subscriptions.id, {
      onDelete: "set null",
    }),
    // The campaign this cycle refreshed, once one exists. Null on the offer
    // line, which produces creatives and no campaign at all.
    campaignId: uuid("campaign_id").references(() => campaigns.id, { onDelete: "set null" }),

    // First instant of the cycle's month, UTC. The natural key for "have we
    // already asked this month" — see the unique index.
    periodMonth: timestamp("period_month", { withTimezone: true }).notNull(),

    // pending   — due, not yet asked
    // prompted  — message sent, waiting on a reply
    // answered  — the owner told us the offer
    // previewed — creatives rendered, approval requested
    // approved  — owner said yes; live or delivered
    // skipped   — no reply inside the window; the previous offer is left running
    status: text("status").notNull().default("pending"),

    // What the owner actually said, verbatim. Kept raw as well as parsed,
    // because the parse is a guess and the original is evidence.
    offerText: text("offer_text"),
    offerExpiresAt: timestamp("offer_expires_at", { withTimezone: true }),

    promptedAt: timestamp("prompted_at", { withTimezone: true }),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    previewedAt: timestamp("previewed_at", { withTimezone: true }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    // Reminders are capped. Nagging a shop owner is how you get reported on
    // WhatsApp, and that costs the channel permanently, not just this customer.
    reminderCount: integer("reminder_count").notNull().default(0),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Exactly one cycle per user per month. This is what makes the scheduler
    // safe to run hourly: the second attempt in a month is a caught duplicate
    // rather than a second WhatsApp message to a real person.
    uniqueIndex("uq_offer_cycles_user_month").on(t.userId, t.periodMonth),
    index("idx_offer_cycles_open")
      .on(t.status, t.promptedAt)
      .where(sql`status in ('pending','prompted','answered','previewed')`),
    check(
      "offer_cycles_status_check",
      sql`${t.status} in ('pending','prompted','answered','previewed','approved','skipped')`,
    ),
  ],
);

// Inbound and outbound WhatsApp messages, for audit and for de-duplicating
// provider retries. Meta redelivers on any non-2xx, and a redelivered "yes"
// must not approve a second month's creative.
export const whatsappMessages = pgTable(
  "whatsapp_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    offerCycleId: uuid("offer_cycle_id").references(() => offerCycles.id, {
      onDelete: "set null",
    }),
    direction: text("direction").notNull(),
    // E.164, as the provider gives it.
    phone: text("phone").notNull(),
    body: text("body"),
    // Provider message id. Unique — this is the replay guard.
    providerRef: text("provider_ref"),
    status: text("status"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_whatsapp_user").on(t.userId, t.createdAt),
    uniqueIndex("uq_whatsapp_provider_ref")
      .on(t.providerRef)
      .where(sql`provider_ref is not null`),
    check("whatsapp_direction_check", sql`${t.direction} in ('inbound','outbound')`),
  ],
);

// ---------------------------------------------------------------------------
// One-off add-on purchases.
//
// Separate from `subscriptions` rather than a status on it, because the two
// have genuinely different lifecycles: a subscription renews forever and its
// hard problem is dunning, while a purchase is charged once and its hard
// problem is that the thing it bought is PRODUCED MINUTES AFTER THE MONEY IS
// TAKEN and can fail afterwards. Folding one into the other would give every
// subscription row a nullable delivery state it never uses, and every purchase
// a dunning ladder that never runs.
// ---------------------------------------------------------------------------
export const purchases = pgTable(
  "purchases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // The campaign the produced creative belongs to. Nullable because checkout
    // happens before the advertiser has necessarily picked one.
    campaignId: uuid("campaign_id").references(() => campaigns.id, { onDelete: "set null" }),

    // Add-on key from lib/pricing (in-cinematic, us-cinematic).
    addOnKey: text("add_on_key").notNull(),
    sku: text("sku").notNull(),
    currencyCode: text("currency_code").notNull(),
    // The price agreed AT CHECKOUT, copied for the same reason subscriptions
    // copy theirs: repricing the list must never change what someone already
    // bought. Zero is legal here (the at_cost waiver still produces a real
    // artefact), so revenue queries must filter amount_minor > 0 rather than
    // assuming every row is a sale.
    amountMinor: integer("amount_minor").notNull(),

    provider: text("provider").notNull(),
    providerRef: text("provider_ref"),

    // pending -> paid -> producing -> delivered
    //                             \-> failed -> refunded
    status: text("status").notNull().default("pending"),

    // The generated CinematicBrief, snapshotted whole. Kept even on failure —
    // it is the only record of what the customer was going to receive, and the
    // first thing to look at when they ask why the ad was refused.
    brief: jsonb("brief"),

    // Production attempts. Generation is metered, so this is a spend counter as
    // much as a reliability one; lib/cinematic/policy caps it.
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),

    paidAt: timestamp("paid_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_purchases_user").on(t.userId, t.createdAt),
    // The replay guard. Both PSPs retry webhooks by design, and without this a
    // retried delivery charges a one-off sale twice.
    uniqueIndex("uq_purchases_provider_ref")
      .on(t.provider, t.providerRef)
      .where(sql`provider_ref is not null`),
    // The renderer's work queue. Partial because delivered rows accumulate
    // forever and are never producible again.
    index("idx_purchases_producible").on(t.createdAt).where(sql`status = 'paid'`),
    check("purchases_currency_check", sql`${t.currencyCode} in ('INR','USD')`),
    check("purchases_sku_check", sql`${t.sku} in ('cinematic')`),
    check(
      "purchases_provider_check",
      sql`${t.provider} in ('razorpay','stripe','paddle','manual')`,
    ),
    check(
      "purchases_status_check",
      sql`${t.status} in ('pending','paid','producing','delivered','failed','refunded','cancelled')`,
    ),
    check("purchases_amount_check", sql`${t.amountMinor} >= 0`),
  ],
);

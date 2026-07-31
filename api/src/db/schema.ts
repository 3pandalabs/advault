import { sql } from "drizzle-orm";
import {
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("users_role_check", sql`${t.role} in ('advertiser','admin')`)],
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
// Google Ads connections. The most sensitive table in this database: a refresh
// token here authorises spending someone else's advertising budget.
//
// `refreshTokenCiphertext` is AES-256-GCM output from lib/crypto.ts, never a
// usable token — a database dump alone does not hand the reader an ad account.
// Access tokens are NOT stored at all: they live ~1 hour and are cheaper to
// re-mint from the refresh token than to keep in sync.
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

    refreshTokenCiphertext: text("refresh_token_ciphertext").notNull(),
    scope: text("scope"),

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
    check("ad_accounts_test_check", sql`${t.isTestAccount} in ('yes','no','unknown')`),
    // Digits only. A customer id with dashes reaches Google as a 400 that reads
    // like an auth failure.
    check("ad_accounts_customer_id_check", sql`${t.customerId} ~ '^[0-9]{5,20}$'`),
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

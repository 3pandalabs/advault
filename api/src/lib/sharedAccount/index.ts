// One 3PandaLabs account across AdVault and SiteVault (2026-11-16, migration
// 0025). AdVault's `users` table is the shared account store:
//
//   - SiteVault creates its sign-ups here (POST /internal/sitevault/accounts,
//     signup_app = 'sitevault'), so the same email + password signs in on both.
//   - Each app stamps its first real use: AdVault on the first campaign,
//     SiteVault on the first website (POST /internal/sitevault/usage).
//
// "Uses AdVault"   = advault_first_used_at IS NOT NULL   (made a campaign)
// "Uses SiteVault" = sitevault_first_used_at IS NOT NULL (has a website)
// SiteVault-only   = uses SiteVault and not AdVault, account not deleted.
// The `account_app_usage` view (0025) is the single SQL definition; everything
// here reads it so the metrics and the selector can never disagree.
//
// Functions take the database as a parameter (no db/index import) so they run
// against PGlite in tests without the full runtime env.

import { eq, sql, type SQL } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { hashSecret } from "../../auth/password.js";
import { users } from "../../db/schema.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = PgDatabase<PgQueryResultHKT, any>;

export type AppName = "advault" | "sitevault";
export type AppUsage = "advault_only" | "sitevault_only" | "both" | "neither";

/** A timestamp the caller may pass (backfill), or now. Never in the future. */
export function usageTime(at: Date | string | null | undefined, now = new Date()): Date {
  if (at == null) return now;
  const d = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(d.getTime()) || d > now) return now;
  return d;
}

export type CreateResult =
  | { status: "created"; userId: string; email: string }
  | { status: "exists"; userId: string; email: string };

/**
 * A new account created from SiteVault (signup_app = 'sitevault'). When the
 * email already has an account, nothing is changed (never the password) and
 * the existing id is returned so SiteVault can link a proven SiteVault login.
 */
export async function createSitevaultAccount(
  db: Db,
  input: { email: string; password: string; createdAt?: Date | string | null; sitevaultUsedAt?: Date | string | null },
): Promise<CreateResult> {
  const email = input.email.trim().toLowerCase();
  const now = new Date();
  const createdAt = usageTime(input.createdAt, now);
  const sitevaultFirstUsedAt = input.sitevaultUsedAt == null ? null : usageTime(input.sitevaultUsedAt, now);
  const [made] = await db
    .insert(users)
    .values({
      email,
      passwordHash: await hashSecret(input.password),
      signupApp: "sitevault",
      sitevaultFirstUsedAt,
      createdAt,
    })
    .onConflictDoNothing({ target: users.email })
    .returning({ id: users.id, email: users.email });
  if (made) return { status: "created", userId: made.id, email: made.email };
  const [existing] = await db.select({ id: users.id, email: users.email }).from(users).where(eq(users.email, email)).limit(1);
  if (!existing) throw new Error("account insert conflicted but no row found");
  // An existing account that now also uses SiteVault.
  if (input.sitevaultUsedAt != null) await markAppUsed(db, existing.id, "sitevault", input.sitevaultUsedAt);
  return { status: "exists", userId: existing.id, email: existing.email };
}

/**
 * Stamp the first use of an app (idempotent: only fills NULL or moves the
 * stamp earlier). Returns false when the account doesn't exist or is deleted.
 */
export async function markAppUsed(db: Db, userId: string, app: AppName, at?: Date | string | null): Promise<boolean> {
  const iso = usageTime(at).toISOString();
  const col = app === "advault" ? users.advaultFirstUsedAt : users.sitevaultFirstUsedAt;
  const set =
    app === "advault"
      ? { advaultFirstUsedAt: sql`least(coalesce(${col}, ${iso}::timestamptz), ${iso}::timestamptz)` }
      : { sitevaultFirstUsedAt: sql`least(coalesce(${col}, ${iso}::timestamptz), ${iso}::timestamptz)` };
  const rows = await db
    .update(users)
    .set(set)
    .where(sql`${users.id} = ${userId} and ${users.deletedAt} is null`)
    .returning({ id: users.id });
  return rows.length > 0;
}

export type UsageCounts = {
  signedUpOnAdvault: number;
  signedUpOnSitevault: number;
  advaultOnly: number;
  sitevaultOnly: number;
  both: number;
  neither: number;
};

/** Raw rows from either driver (node-postgres in prod, PGlite in tests): both return `{ rows }`. */
async function rowsOf<T>(db: Db, query: SQL): Promise<T[]> {
  const res = (await db.execute(query)) as unknown as { rows: T[] };
  return res.rows;
}

/** Live accounts by signup app and by which apps they use (the account_app_usage view). */
export async function accountUsageCounts(db: Db): Promise<UsageCounts> {
  const [r] = await rowsOf<{
    signed_up_advault: number;
    signed_up_sitevault: number;
    advault_only: number;
    sitevault_only: number;
    both: number;
    neither: number;
  }>(db, sql`
    select
      count(*) filter (where signup_app = 'advault')::int as signed_up_advault,
      count(*) filter (where signup_app = 'sitevault')::int as signed_up_sitevault,
      count(*) filter (where app_usage = 'advault_only')::int as advault_only,
      count(*) filter (where app_usage = 'sitevault_only')::int as sitevault_only,
      count(*) filter (where app_usage = 'both')::int as both,
      count(*) filter (where app_usage = 'neither')::int as neither
    from account_app_usage
  `);
  if (!r) throw new Error("account usage query returned no row");
  return {
    signedUpOnAdvault: Number(r.signed_up_advault),
    signedUpOnSitevault: Number(r.signed_up_sitevault),
    advaultOnly: Number(r.advault_only),
    sitevaultOnly: Number(r.sitevault_only),
    both: Number(r.both),
    neither: Number(r.neither),
  };
}

export type AccountUsageRow = {
  id: string;
  email: string;
  signupApp: AppName;
  createdAt: Date;
  sitevaultFirstUsedAt: Date | null;
};

/**
 * SiteVault-only customers: a live account with a SiteVault website and no
 * AdVault campaign, oldest SiteVault customer first. The list to give
 * SiteVault-only benefits to.
 */
export async function sitevaultOnlyCustomers(db: Db): Promise<AccountUsageRow[]> {
  const rows = await rowsOf<{
    id: string;
    email: string;
    signup_app: AppName;
    created_at: string | Date;
    sitevault_first_used_at: string | Date | null;
  }>(db, sql`
    select id, email, signup_app, created_at, sitevault_first_used_at
      from account_app_usage
     where app_usage = 'sitevault_only'
     order by sitevault_first_used_at, created_at
  `);
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    signupApp: r.signup_app,
    createdAt: new Date(r.created_at),
    sitevaultFirstUsedAt: r.sitevault_first_used_at == null ? null : new Date(r.sitevault_first_used_at),
  }));
}

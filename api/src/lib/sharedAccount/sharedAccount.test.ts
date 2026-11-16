// Runs against a real (in-process) Postgres: PGlite with every drizzle/*.sql
// migration applied, so the 0025 backfill, the account_app_usage view and the
// queries here are tested as Postgres will run them in production.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { verifySecret } from "../../auth/password.js";
import * as schema from "../../db/schema.js";
import {
  accountUsageCounts,
  createSitevaultAccount,
  markAppUsed,
  sitevaultOnlyCustomers,
  usageTime,
  type Db,
} from "./index.js";

const MIGRATIONS = join(__dirname, "../../../drizzle");
const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
const SHARED = "0025_shared_account.sql";

async function freshDb(upTo?: string): Promise<{ pg: PGlite; db: Db }> {
  const pg = new PGlite();
  for (const f of files) {
    if (upTo && f >= upTo) break;
    await pg.exec(readFileSync(join(MIGRATIONS, f), "utf8").replaceAll("--> statement-breakpoint", ""));
  }
  return { pg, db: drizzle(pg, { schema }) as unknown as Db };
}

async function addUser(pg: PGlite, email: string, extra: { deleted?: boolean } = {}): Promise<string> {
  const r = await pg.query<{ id: string }>(
    `insert into users (email, password_hash, deleted_at) values ($1, 'x', $2) returning id`,
    [email, extra.deleted ? new Date() : null],
  );
  return r.rows[0]!.id;
}

async function addCampaign(pg: PGlite, userId: string, createdAt: string, site = false): Promise<string> {
  const r = await pg.query<{ id: string }>(
    `insert into campaigns (user_id, name, business_name, business_category, target_zip_codes, daily_budget_cents, created_at, sitevault_edit_enc)
     values ($1, 'c', 'b', 'Plumbing', '{07094}', 1000, $2, $3) returning id`,
    [userId, createdAt, site ? "enc" : null],
  );
  return r.rows[0]!.id;
}

async function userRow(pg: PGlite, id: string) {
  const r = await pg.query<{
    signup_app: string;
    advault_first_used_at: Date | null;
    sitevault_first_used_at: Date | null;
    created_at: Date;
    password_hash: string;
  }>(`select signup_app, advault_first_used_at, sitevault_first_used_at, created_at, password_hash from users where id = $1`, [id]);
  return r.rows[0]!;
}

describe("migration 0025_shared_account", () => {
  it("adds the columns, backfills existing users, and is idempotent", async () => {
    const { pg } = await freshDb(SHARED);
    const adOnly = await addUser(pg, "ad@x.test");
    const withSite = await addUser(pg, "site@x.test");
    const idle = await addUser(pg, "idle@x.test");
    await addCampaign(pg, adOnly, "2026-10-02T00:00:00Z");
    await addCampaign(pg, adOnly, "2026-10-01T00:00:00Z");
    await addCampaign(pg, withSite, "2026-11-01T00:00:00Z", true);

    const sql = readFileSync(join(MIGRATIONS, SHARED), "utf8");
    await pg.exec(sql);
    const check = async () => {
      const a = await userRow(pg, adOnly);
      expect(a.signup_app).toBe("advault");
      expect(a.advault_first_used_at?.toISOString()).toBe("2026-10-01T00:00:00.000Z");
      expect(a.sitevault_first_used_at).toBeNull();
      const s = await userRow(pg, withSite);
      expect(s.advault_first_used_at?.toISOString()).toBe("2026-11-01T00:00:00.000Z");
      expect(s.sitevault_first_used_at?.toISOString()).toBe("2026-11-01T00:00:00.000Z");
      const i = await userRow(pg, idle);
      expect(i.advault_first_used_at).toBeNull();
      expect(i.sitevault_first_used_at).toBeNull();
    };
    await check();
    // Re-running (a redeploy that replays it) changes nothing and doesn't fail.
    await pg.exec(sql);
    await check();
    // The CHECK constraint holds.
    await expect(pg.query(`update users set signup_app = 'other' where id = $1`, [idle])).rejects.toThrow();
  });
});

describe("shared account store", () => {
  let pg: PGlite;
  let db: Db;
  beforeEach(async () => {
    ({ pg, db } = await freshDb());
  });

  it("creates a SiteVault sign-up with a bcrypt password AdVault login accepts", async () => {
    const r = await createSitevaultAccount(db, { email: " New@X.test ", password: "ninechars" });
    expect(r.status).toBe("created");
    expect(r.email).toBe("new@x.test");
    const row = await userRow(pg, r.userId);
    expect(row.signup_app).toBe("sitevault");
    expect(await verifySecret("ninechars", row.password_hash)).toBe(true);
    expect(row.sitevault_first_used_at).toBeNull();
  });

  it("keeps the original SiteVault createdAt and first-use on a lazy migration", async () => {
    const r = await createSitevaultAccount(db, {
      email: "old@x.test",
      password: "correct horse",
      createdAt: "2026-11-15T10:00:00Z",
      sitevaultUsedAt: "2026-11-15T10:05:00Z",
    });
    const row = await userRow(pg, r.userId);
    expect(row.created_at.toISOString()).toBe("2026-11-15T10:00:00.000Z");
    expect(row.sitevault_first_used_at?.toISOString()).toBe("2026-11-15T10:05:00.000Z");
  });

  it("links an email that already exists without touching its password", async () => {
    const id = await addUser(pg, "both@x.test");
    const r = await createSitevaultAccount(db, { email: "both@x.test", password: "a different one", sitevaultUsedAt: "2026-11-10T00:00:00Z" });
    expect(r).toEqual({ status: "exists", userId: id, email: "both@x.test" });
    const row = await userRow(pg, id);
    expect(row.password_hash).toBe("x");
    expect(row.signup_app).toBe("advault");
    expect(row.sitevault_first_used_at?.toISOString()).toBe("2026-11-10T00:00:00.000Z");
  });

  it("stamps first use once, only ever earlier, never for a deleted account", async () => {
    const id = await addUser(pg, "u@x.test");
    expect(await markAppUsed(db, id, "sitevault", "2026-11-12T00:00:00Z")).toBe(true);
    await markAppUsed(db, id, "sitevault", "2026-11-14T00:00:00Z");
    expect((await userRow(pg, id)).sitevault_first_used_at?.toISOString()).toBe("2026-11-12T00:00:00.000Z");
    await markAppUsed(db, id, "sitevault", "2026-11-11T00:00:00Z");
    expect((await userRow(pg, id)).sitevault_first_used_at?.toISOString()).toBe("2026-11-11T00:00:00.000Z");
    await markAppUsed(db, id, "advault");
    expect((await userRow(pg, id)).advault_first_used_at).not.toBeNull();

    const gone = await addUser(pg, "gone@x.test", { deleted: true });
    expect(await markAppUsed(db, gone, "sitevault")).toBe(false);
    expect(await markAppUsed(db, "00000000-0000-0000-0000-000000000000", "sitevault")).toBe(false);
  });

  it("counts accounts by signup app and usage, and selects SiteVault-only customers", async () => {
    const adOnly = await addUser(pg, "ad@x.test");
    await markAppUsed(db, adOnly, "advault");
    const both = await addUser(pg, "both@x.test");
    await markAppUsed(db, both, "advault");
    await markAppUsed(db, both, "sitevault");
    await addUser(pg, "idle@x.test");
    const svEarly = await createSitevaultAccount(db, { email: "sv1@x.test", password: "pw-pw-pw-pw", sitevaultUsedAt: "2026-11-01T00:00:00Z" });
    const svLate = await createSitevaultAccount(db, { email: "sv2@x.test", password: "pw-pw-pw-pw", sitevaultUsedAt: "2026-11-05T00:00:00Z" });
    await createSitevaultAccount(db, { email: "sv-idle@x.test", password: "pw-pw-pw-pw" });
    // An AdVault sign-up who only ever made a website is SiteVault-only too.
    const adSignupSiteOnly = await addUser(pg, "adsignup@x.test");
    await markAppUsed(db, adSignupSiteOnly, "sitevault", "2026-11-03T00:00:00Z");
    // Deleted accounts are never counted or selected.
    const gone = await addUser(pg, "gone@x.test");
    await markAppUsed(db, gone, "sitevault");
    await pg.query(`update users set deleted_at = now() where id = $1`, [gone]);

    expect(await accountUsageCounts(db)).toEqual({
      signedUpOnAdvault: 4,
      signedUpOnSitevault: 3,
      advaultOnly: 1,
      sitevaultOnly: 3,
      both: 1,
      neither: 2,
    });
    const only = await sitevaultOnlyCustomers(db);
    expect(only.map((r) => r.id)).toEqual([svEarly.userId, adSignupSiteOnly, svLate.userId]);
    expect(only[1]!.signupApp).toBe("advault");
  });
});

describe("usageTime", () => {
  const now = new Date("2026-11-16T00:00:00Z");
  it("uses now for missing, invalid or future times", () => {
    expect(usageTime(null, now)).toBe(now);
    expect(usageTime("nonsense", now)).toBe(now);
    expect(usageTime("2027-01-01T00:00:00Z", now)).toBe(now);
    expect(usageTime("2026-11-01T00:00:00Z", now).toISOString()).toBe("2026-11-01T00:00:00.000Z");
  });
});

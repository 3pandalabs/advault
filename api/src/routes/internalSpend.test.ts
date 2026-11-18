// GET /admin/internal-spend through Fastify against PGlite: per internal
// account (0032) what it paid AdVault in a range, split by purpose, and the
// Google spend on its campaigns. Customers never appear; out-of-range money
// is left out; token and session guards hold.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import Fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "../db/schema.js";

const holder = vi.hoisted(() => {
  // env.ts refuses to load without these; nothing here connects to them.
  const dummy: Record<string, string> = {
    DATABASE_URL: "postgres://unused@localhost/unused",
    JWT_SECRET: "test-jwt-secret-test-jwt-secret-0000",
    R2_ACCOUNT_ID: "x",
    R2_ACCESS_KEY_ID: "x",
    R2_SECRET_ACCESS_KEY: "x",
    R2_BUCKET: "x",
    R2_ENDPOINT: "https://r2.invalid",
    TOKEN_ENCRYPTION_KEY: "0".repeat(64),
    METRICS_TOKEN: "metrics-token-for-tests",
    ADMIN_ANALYTICS_TOKEN: "analytics-token-for-tests",
  };
  for (const [k, v] of Object.entries(dummy)) process.env[k] ??= v;
  return { db: null as unknown };
});

vi.mock("../db/index.js", () => ({
  get db() {
    return holder.db;
  },
}));

let app: FastifyInstance;
let pg: PGlite;
let adminId: string;
let customerId: string;

const IN = "2026-11-10T12:00:00Z";
const OUT = "2026-10-20T12:00:00Z";
const RANGE = "since=2026-11-01&until=2026-12-01";

async function newUser(email: string, role: "admin" | "advertiser", label?: string): Promise<string> {
  const r = await pg.query<{ id: string }>(
    `insert into users (email, password_hash, role, is_internal, internal_label) values ($1, 'x', $2, $3, $4) returning id`,
    [email, role, label !== undefined, label ?? null],
  );
  return r.rows[0]!.id;
}

async function purchase(userId: string, sku: string, amountMinor: number, at: string, status = "paid") {
  await pg.query(
    `insert into purchases (user_id, add_on_key, sku, currency_code, amount_minor, provider, status, paid_at, created_at)
     values ($1, 'x', $2, 'USD', $3, 'stripe', $4, $5, $5)`,
    [userId, sku, amountMinor, status, at],
  );
}

async function topup(userId: string, amountMinor: number, at: string, status = "paid") {
  await pg.query(
    `insert into payments (user_id, provider, amount_minor, currency_code, purpose, status, updated_at)
     values ($1, 'stripe', $2, 'USD', 'topup', $3, $4)`,
    [userId, amountMinor, status, at],
  );
}

async function wallet(userId: string): Promise<string> {
  const r = await pg.query<{ id: string }>(`insert into wallets (user_id, currency_code) values ($1, 'USD') returning id`, [userId]);
  return r.rows[0]!.id;
}

async function invoice(userId: string, amountMinor: number, at: string, externalWalletId: string | null) {
  const sub = await pg.query<{ id: string }>(
    `insert into subscriptions (user_id, plan_key, line, currency_code, amount_minor, provider, status)
     values ($1, 'us-managed', 'managed', 'USD', $2, 'stripe', $3) returning id`,
    // One live subscription per user; the second is an older, canceled one.
    [userId, amountMinor, externalWalletId ? "active" : "canceled"],
  );
  const inv = await pg.query<{ id: string }>(
    `insert into subscription_invoices (subscription_id, user_id, amount_minor, currency_code, period_start, period_end, status, paid_at)
     values ($1, $2, $3, 'USD', $4, $4::timestamptz + interval '30 days', 'paid', $4) returning id`,
    [sub.rows[0]!.id, userId, amountMinor, at],
  );
  if (externalWalletId) {
    await pg.query(
      `insert into ledger_entries (wallet_id, type, amount_minor, currency_code, external_ref) values ($1, 'topup', $2, 'USD', $3)`,
      [externalWalletId, amountMinor, `subinv:${inv.rows[0]!.id}`],
    );
  }
}

async function campaignWithSpend(userId: string, days: [string, number][]) {
  const c = await pg.query<{ id: string }>(
    `insert into campaigns (user_id, name, business_name, business_category, target_zip_codes, daily_budget_cents, launched_at)
     values ($1, 'c', 'b', 'other', '{10001}', 1000, now()) returning id`,
    [userId],
  );
  for (const [date, micros] of days) {
    await pg.query(`insert into campaign_daily_metrics (campaign_id, date, cost_micros) values ($1, $2, $3)`, [c.rows[0]!.id, date, micros]);
  }
  return c.rows[0]!.id;
}

beforeAll(async () => {
  pg = new PGlite();
  const dir = join(__dirname, "../../drizzle");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    await pg.exec(readFileSync(join(dir, f), "utf8").replaceAll("--> statement-breakpoint", ""));
  }
  holder.db = drizzle(pg, { schema });
  adminId = await newUser("admin@x.test", "admin");
  customerId = await newUser("shop@x.test", "advertiser");
  const site = await newUser("sitevault@3pandalabs.test", "advertiser", "SiteVault");
  const rsvp = await newUser("rsvp@3pandalabs.test", "advertiser", "RsvpVault");

  // SiteVault: in range $10 ad + $10 website + $50 top-up + $19 plan (own
  // charge) + $29 plan from the wallet; out of range and unpaid rows ignored.
  await purchase(site, "new_ad", 1000, IN);
  await purchase(site, "website", 1000, IN);
  await purchase(site, "new_ad", 1000, OUT);
  await purchase(site, "new_ad", 1000, IN, "pending");
  await topup(site, 5000, IN);
  await topup(site, 7000, IN, "created");
  await topup(site, 9000, OUT);
  const w = await wallet(site);
  await invoice(site, 1900, IN, w);
  await invoice(site, 2900, IN, null);
  await campaignWithSpend(site, [
    ["2026-11-02", 12_340_000],
    ["2026-11-03", 5_000_000],
    ["2026-10-31", 99_000_000],
  ]);
  // RsvpVault: nothing in range.
  await purchase(rsvp, "new_ad", 1000, OUT);
  // A real customer: never reported.
  await purchase(customerId, "new_ad", 1000, IN);
  await topup(customerId, 5000, IN);
  await campaignWithSpend(customerId, [["2026-11-02", 7_000_000]]);

  const { authPlugin } = await import("../auth/plugin.js");
  const { adminInsightsRoutes } = await import("./adminInsights.js");
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(authPlugin);
  await app.register(adminInsightsRoutes);
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
});

const get = (url: string, token?: string) =>
  app.inject({ method: "GET", url, headers: token ? { authorization: `Bearer ${token}` } : {} });

describe("GET /admin/internal-spend", () => {
  it("splits what each internal account paid and reports its Google spend", async () => {
    const res = await get(`/admin/internal-spend?${RANGE}`, "analytics-token-for-tests");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.since).toBe("2026-11-01");
    expect(body.accounts.map((a: { label: string }) => a.label)).toEqual(["RsvpVault", "SiteVault"]);
    const site = body.accounts.find((a: { label: string }) => a.label === "SiteVault");
    expect(site).toMatchObject({
      email: "sitevault@3pandalabs.test",
      currency: "USD",
      paid: {
        adBudgetMinor: 5000,
        adsMinor: 1000,
        websiteMinor: 1000,
        siteOfferMinor: 0,
        videoBundleMinor: 0,
        planMinor: 1900,
        otherMinor: 0,
        feesMinor: 3900,
        totalMinor: 8900,
      },
      planFromWalletMinor: 2900,
      adSpendMinor: 1734,
      campaignsWithSpend: 1,
      launchedCampaigns: 1,
      adsMade: 0,
    });
    const rsvp = body.accounts.find((a: { label: string }) => a.label === "RsvpVault");
    expect(rsvp.paid.totalMinor).toBe(0);
    expect(rsvp.adSpendMinor).toBe(0);
    expect(JSON.stringify(body)).not.toContain("shop@x.test");
    expect(JSON.stringify(body)).not.toContain('"id"');
  });

  it("needs the analytics token or an admin session", async () => {
    expect((await get(`/admin/internal-spend?${RANGE}`)).statusCode).toBe(401);
    expect((await get(`/admin/internal-spend?${RANGE}`, "wrong")).statusCode).toBe(401);
    const { signAccessToken } = await import("../auth/jwt.js");
    const customer = signAccessToken({ sub: customerId, role: "advertiser" });
    expect((await get(`/admin/internal-spend?${RANGE}`, customer)).statusCode).toBe(403);
    const admin = signAccessToken({ sub: adminId, role: "admin" });
    expect((await get(`/admin/internal-spend?${RANGE}`, admin)).statusCode).toBe(200);
  });

  it("rejects a malformed range", async () => {
    expect((await get("/admin/internal-spend?since=nov&until=2026-12-01", "analytics-token-for-tests")).statusCode).toBe(400);
  });
});

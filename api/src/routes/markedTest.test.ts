// Accounts marked as test (0046) through Fastify against PGlite: the admin
// route, that the account still signs in and is billed like any customer, and
// that it is left out of /admin/business, /metrics revenue and
// /admin/ad-production, and counted as test in /admin/account-counts.
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
let reviewerId: string;
let sign: (p: { sub: string; role: "admin" | "advertiser" }) => string;

const REVIEWER = "play-reviewer@example.com";
const PASSWORD = "reviewer-password-123";

async function newUser(email: string, role: "admin" | "advertiser", hash = "x", testOwnerId: string | null = null): Promise<string> {
  const r = await pg.query<{ id: string }>(
    `insert into users (email, password_hash, role, test_owner_id) values ($1, $2, $3, $4) returning id`,
    [email, hash, role, testOwnerId],
  );
  return r.rows[0]!.id;
}

async function paidAd(userId: string) {
  await pg.query(
    `insert into purchases (user_id, add_on_key, sku, currency_code, amount_minor, provider, status, paid_at)
     values ($1, 'us-new-ad', 'new_ad', 'USD', 1000, 'stripe', 'paid', now())`,
    [userId],
  );
}

beforeAll(async () => {
  pg = new PGlite();
  const dir = join(__dirname, "../../drizzle");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    await pg.exec(readFileSync(join(dir, f), "utf8").replaceAll("--> statement-breakpoint", ""));
  }
  // 0046 is idempotent (runs at every container start).
  await pg.exec(readFileSync(join(dir, "0046_marked_test_accounts.sql"), "utf8"));
  holder.db = drizzle(pg, { schema });

  const { hashSecret } = await import("../auth/password.js");
  adminId = await newUser("admin@x.test", "admin");
  customerId = await newUser("shop@x.test", "advertiser");
  reviewerId = await newUser(REVIEWER, "advertiser", await hashSecret(PASSWORD));
  await newUser("t1@test.invalid", "advertiser", "x", adminId);
  await paidAd(customerId);
  await paidAd(reviewerId);

  sign = (await import("../auth/jwt.js")).signAccessToken;
  const { authPlugin } = await import("../auth/plugin.js");
  const { authRoutes } = await import("./auth.js");
  const { adminUserRoutes } = await import("./adminUsers.js");
  const { metricsRoutes } = await import("./metrics.js");
  const { adMetricsRoutes } = await import("./adMetrics.js");
  const { adminInsightsRoutes } = await import("./adminInsights.js");
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(authPlugin);
  await app.register(authRoutes);
  await app.register(adminUserRoutes);
  await app.register(metricsRoutes);
  await app.register(adMetricsRoutes);
  await app.register(adminInsightsRoutes);
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
});

const call = (method: "GET" | "POST", url: string, token: string, payload?: unknown) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload: payload as object } : {}) });
const adminToken = () => sign({ sub: adminId, role: "admin" });
const mark = (email: string, test: boolean) => call("POST", "/admin/test-accounts", adminToken(), { email, test });
const customerIds = async (): Promise<string[]> =>
  (await call("GET", "/admin/business", adminToken())).json().customers.map((c: { id: string }) => c.id);

describe("who may", () => {
  it("a customer, or an admin JWT for a non-admin, is refused (403); nothing changes", async () => {
    const t = sign({ sub: customerId, role: "advertiser" });
    expect((await call("GET", "/admin/test-accounts", t)).statusCode).toBe(403);
    expect((await call("POST", "/admin/test-accounts", t, { email: REVIEWER, test: true })).statusCode).toBe(403);
    const forged = sign({ sub: customerId, role: "admin" });
    expect((await call("POST", "/admin/test-accounts", forged, { email: REVIEWER, test: true })).statusCode).toBe(403);
    const { rows } = await pg.query<{ marked_test: boolean }>(`select marked_test from users where id = $1`, [reviewerId]);
    expect(rows[0]!.marked_test).toBe(false);
  });

  it("refuses a test customer, an admin and an unknown email", async () => {
    expect((await mark("t1@test.invalid", true)).json()).toEqual({ error: "test_customer" });
    expect((await mark("admin@x.test", true)).json()).toEqual({ error: "admin_account" });
    expect((await mark("nobody@x.test", true)).statusCode).toBe(404);
  });
});

describe("a marked account", () => {
  beforeAll(async () => {
    expect((await customerIds()).sort()).toEqual([customerId, reviewerId].sort());
    const res = await mark("PLAY-REVIEWER@example.com", true);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().user).toMatchObject({ id: reviewerId, markedTest: true });
  });

  it("is listed", async () => {
    const list = (await call("GET", "/admin/test-accounts", adminToken())).json();
    expect(list.users.map((u: { id: string }) => u.id)).toEqual([reviewerId]);
  });

  it("still signs in and is billed like a normal customer (not a test customer, not test mode)", async () => {
    const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email: REVIEWER, password: PASSWORD } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().accessToken).toBeTruthy();
    const me = (await call("GET", "/auth/me", sign({ sub: reviewerId, role: "advertiser" }))).json();
    expect(me).toMatchObject({ isTestCustomer: false });
    const { billingIdentity } = await import("../lib/testMode/index.js");
    expect(await billingIdentity(reviewerId)).toMatchObject({ role: "advertiser", testMode: false, exempt: false, internal: false });
  });

  it("is left out of /admin/business customers and revenue", async () => {
    const body = (await call("GET", "/admin/business", adminToken())).json();
    expect(body.customers.map((c: { id: string }) => c.id)).toEqual([customerId]);
    expect(body.revenue.find((r: { source: string }) => r.source.startsWith("Ads")).count).toBe(1);
  });

  it("is left out of /metrics revenue and /admin/ad-production paidAds", async () => {
    const m = await app.inject({ method: "GET", url: "/metrics", headers: { authorization: "Bearer metrics-token-for-tests" } });
    expect(m.json().counts).toMatchObject({ addOnRevenueMinorUsd: 1000 });
    const today = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    expect((await call("GET", `/admin/ad-production?since=${today}&until=${tomorrow}`, adminToken())).json()).toMatchObject({ paidAds: 1 });
  });

  it("counts as test in /admin/account-counts, apart from admins' test customers", async () => {
    const body = (await call("GET", "/admin/account-counts", adminToken())).json();
    expect(body).toMatchObject({ real: 1, test: { total: 2, createdByAdmins: 1, markedByAdmin: 1 }, internal: { total: 0 }, admins: 1 });
  });

  it("unmarking makes it a real customer again", async () => {
    expect((await mark(REVIEWER, false)).json().user).toMatchObject({ markedTest: false });
    expect((await customerIds()).sort()).toEqual([customerId, reviewerId].sort());
    expect((await call("GET", "/admin/test-accounts", adminToken())).json().users).toEqual([]);
  });
});

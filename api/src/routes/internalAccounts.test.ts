// Internal accounts (0032) through Fastify against PGlite: the admin route,
// revenue exclusion in /metrics, /admin/ad-production and /admin/business, and
// full-price checkout tagged internal=1.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import Fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
  };
  for (const [k, v] of Object.entries(dummy)) process.env[k] ??= v;
  return {
    db: null as unknown,
    checkouts: [] as { amountMinor: number; testMode?: boolean; internal?: boolean; internalLabel?: string | null }[],
  };
});

vi.mock("../db/index.js", () => ({
  get db() {
    return holder.db;
  },
}));

// Checkout stubbed: records what the wallet top-up would charge.
vi.mock("../lib/payments/index.js", async (orig) => ({
  ...(await orig<object>()),
  providerFor: () => ({
    name: "stripe",
    isConfigured: () => true,
    createCheckout: async (req: { paymentId: string; amountMinor: number }) => {
      holder.checkouts.push(req);
      return { providerRef: `cs_test_${req.paymentId}`, redirectUrl: "https://checkout.invalid" };
    },
  }),
}));

let app: FastifyInstance;
let pg: PGlite;
let adminId: string;
let customerId: string;
let internalId: string;
let sign: (p: { sub: string; role: "admin" | "advertiser" }) => string;

async function newUser(email: string, role: "admin" | "advertiser"): Promise<string> {
  const r = await pg.query<{ id: string }>(`insert into users (email, password_hash, role) values ($1, 'x', $2) returning id`, [email, role]);
  return r.rows[0]!.id;
}

async function paidAd(userId: string, amountMinor = 1000) {
  await pg.query(
    `insert into purchases (user_id, add_on_key, sku, currency_code, amount_minor, provider, status, paid_at)
     values ($1, 'us-new-ad', 'new_ad', 'USD', $2, 'stripe', 'paid', now())`,
    [userId, amountMinor],
  );
}

beforeAll(async () => {
  pg = new PGlite();
  const dir = join(__dirname, "../../drizzle");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    await pg.exec(readFileSync(join(dir, f), "utf8").replaceAll("--> statement-breakpoint", ""));
  }
  // 0032 is idempotent (runs at every container start).
  await pg.exec(readFileSync(join(dir, "0032_internal_accounts.sql"), "utf8"));
  holder.db = drizzle(pg, { schema });
  adminId = await newUser("admin@x.test", "admin");
  customerId = await newUser("shop@x.test", "advertiser");
  internalId = await newUser("advault@3pandalabs.test", "advertiser");

  sign = (await import("../auth/jwt.js")).signAccessToken;
  const { authPlugin } = await import("../auth/plugin.js");
  const { authRoutes } = await import("./auth.js");
  const { adminUserRoutes } = await import("./adminUsers.js");
  const { billingRoutes } = await import("./billing.js");
  const { metricsRoutes } = await import("./metrics.js");
  const { adMetricsRoutes } = await import("./adMetrics.js");
  const { adminInsightsRoutes } = await import("./adminInsights.js");
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(authPlugin);
  await app.register(authRoutes);
  await app.register(adminUserRoutes);
  await app.register(billingRoutes);
  await app.register(metricsRoutes);
  await app.register(adMetricsRoutes);
  await app.register(adminInsightsRoutes);
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
});

beforeEach(() => {
  holder.checkouts.length = 0;
});

const call = (method: "GET" | "POST", url: string, token: string, payload?: unknown) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload: payload as object } : {}) });

const adminToken = () => sign({ sub: adminId, role: "admin" });
const mark = (email: string, internal: boolean, label?: string) =>
  call("POST", "/admin/internal-accounts", adminToken(), { email, internal, ...(label ? { label } : {}) });

describe("who may", () => {
  it("a customer cannot list or set internal accounts (403)", async () => {
    const t = sign({ sub: customerId, role: "advertiser" });
    expect((await call("GET", "/admin/internal-accounts", t)).statusCode).toBe(403);
    expect((await call("POST", "/admin/internal-accounts", t, { email: "shop@x.test", internal: true })).statusCode).toBe(403);
  });

  it("an admin JWT for a non-admin user is refused: the DB role decides", async () => {
    const t = sign({ sub: customerId, role: "admin" });
    expect((await call("POST", "/admin/internal-accounts", t, { email: "shop@x.test", internal: true })).statusCode).toBe(403);
    const { rows } = await pg.query<{ is_internal: boolean }>(`select is_internal from users where id = $1`, [customerId]);
    expect(rows[0]!.is_internal).toBe(false);
  });
});

describe("set and unset", () => {
  it("an admin marks by email (any case) with a label, lists it, and unmarks it", async () => {
    const res = await mark("ADVAULT@3pandalabs.test", true, "SiteVault");
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().user).toMatchObject({ id: internalId, isInternal: true, internalLabel: "SiteVault" });
    const list = (await call("GET", "/admin/internal-accounts", adminToken())).json();
    expect(list.users.map((u: { id: string }) => u.id)).toEqual([internalId]);
    const me = (await call("GET", "/auth/me", sign({ sub: internalId, role: "advertiser" }))).json();
    expect(me).toMatchObject({ isInternal: true, internalLabel: "SiteVault" });

    const off = await mark("advault@3pandalabs.test", false);
    expect(off.json().user).toMatchObject({ isInternal: false, internalLabel: null });
    expect((await call("GET", "/admin/internal-accounts", adminToken())).json().users).toEqual([]);
  });

  it("an unknown email is 404", async () => {
    expect((await mark("nobody@x.test", true)).statusCode).toBe(404);
  });
});

describe("revenue and traction", () => {
  beforeAll(async () => {
    await mark("advault@3pandalabs.test", true, "SiteVault");
    await paidAd(customerId, 1000);
    await paidAd(internalId, 1000);
    await paidAd(internalId, 1000);
  });

  it("/metrics keeps internal payments out of revenue and reports them apart", async () => {
    const res = await app.inject({ method: "GET", url: "/metrics", headers: { authorization: "Bearer metrics-token-for-tests" } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().counts).toMatchObject({
      addOnRevenueMinorUsd: 1000,
      internalAccounts: 1,
      internalAddOnRevenueMinorUsd: 2000,
    });
  });

  it("/admin/ad-production counts internal ads apart from paidAds", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const res = await call("GET", `/admin/ad-production?since=${today}&until=${tomorrow}`, adminToken());
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ paidAds: 1, internalPaidAds: 2 });
  });

  it("/admin/business leaves internal accounts out of customers and revenue, listed under internal", async () => {
    const res = await call("GET", "/admin/business", adminToken());
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.customers.map((c: { id: string }) => c.id)).toContain(customerId);
    expect(body.customers.map((c: { id: string }) => c.id)).not.toContain(internalId);
    const ads = body.revenue.find((r: { source: string }) => r.source.startsWith("Ads"));
    expect(ads.count).toBe(1);
    expect(body.internal).toEqual([expect.objectContaining({ id: internalId, label: "SiteVault", paidMinor: 2000 })]);
  });
});

describe("billing is unchanged", () => {
  it("an internal account pays full price, tagged internal (not test mode)", async () => {
    await mark("advault@3pandalabs.test", true, "SiteVault");
    const { billingIdentity } = await import("../lib/testMode/index.js");
    expect(await billingIdentity(internalId)).toMatchObject({
      role: "advertiser",
      testMode: false,
      exempt: false,
      internal: true,
      internalLabel: "SiteVault",
    });
    const { quoteNewAd } = await import("../lib/newAd/index.js");
    expect(await quoteNewAd(internalId)).toMatchObject({ amountMinor: 1000, testMode: false, internal: true });

    const res = await call("POST", "/wallet/topup", sign({ sub: internalId, role: "advertiser" }), { amountMinor: 10_000 });
    expect(res.statusCode, res.body).toBe(201);
    expect(holder.checkouts).toEqual([
      expect.objectContaining({ amountMinor: 10_000, testMode: false, internal: true, internalLabel: "SiteVault" }),
    ]);
  });

  it("a normal customer's checkout is not tagged", async () => {
    const res = await call("POST", "/wallet/topup", sign({ sub: customerId, role: "advertiser" }), { amountMinor: 10_000 });
    expect(res.statusCode, res.body).toBe(201);
    expect(holder.checkouts).toEqual([expect.objectContaining({ amountMinor: 10_000, internal: false })]);
  });
});

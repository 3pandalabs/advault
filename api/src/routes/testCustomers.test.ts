// Admin test customers (0030) through Fastify against PGlite: the real JWT
// auth plugin, the switch routes, /auth/refresh, and launch with Google stubbed.
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
  };
  for (const [k, v] of Object.entries(dummy)) process.env[k] ??= v;
  return { db: null as unknown, launches: [] as { validateOnly?: boolean }[], checkouts: [] as { amountMinor: number; testMode?: boolean }[] };
});

vi.mock("../db/index.js", () => ({
  get db() {
    return holder.db;
  },
}));

// Google, R2 and Mercury stubbed: launch runs every gate for real and stops at
// the one atomic mutate, which records the options it was called with.
vi.mock("../lib/googleAds/env.js", async (orig) => ({ ...(await orig<object>()), isGoogleAdsConfigured: () => true }));
vi.mock("../lib/googleAds/mcc.js", async (orig) => ({ ...(await orig<object>()), mccAccessToken: async () => "token" }));
vi.mock("../lib/googleAds/client.js", async (orig) => ({
  ...(await orig<object>()),
  getCustomerDetails: async () => ({ isManager: false }),
}));
vi.mock("../lib/googleAds/campaigns.js", async (orig) => ({
  ...(await orig<object>()),
  resolveZipCriteria: async () => ["geoTargetConstants/1"],
}));
vi.mock("../lib/googleAds/demandGen.js", async (orig) => ({
  ...(await orig<object>()),
  findLogoAsset: async () => null,
  findYoutubeVideoAsset: async () => null,
  launchDemandGen: async (_ctx: unknown, _plan: unknown, opts: { validateOnly?: boolean } = {}) => {
    holder.launches.push(opts);
    return { campaignResourceName: "customers/1/campaigns/1", adResourceName: "customers/1/adGroupAds/1" };
  },
}));
vi.mock("../plugins/r2.js", async (orig) => ({ ...(await orig<object>()), getObjectBytes: async () => Buffer.from("logo") }));
vi.mock("../lib/imageSize.js", async (orig) => ({ ...(await orig<object>()), checkLogo: () => ({ ok: true }) }));
// Checkout stubbed: records what the wallet top-up would charge.
vi.mock("../lib/payments/index.js", async (orig) => ({
  ...(await orig<object>()),
  providerFor: () => ({
    name: "stripe",
    isConfigured: () => true,
    createCheckout: async (req: { paymentId: string; amountMinor: number; testMode?: boolean }) => {
      holder.checkouts.push(req);
      return { providerRef: `cs_test_${req.paymentId}`, redirectUrl: "https://checkout.invalid" };
    },
  }),
}));
vi.mock("../lib/billing/managedCard.js", async (orig) => ({ ...(await orig<object>()), syncCardLimit: async () => undefined }));

let app: FastifyInstance;
let pg: PGlite;
let adminId: string;
let otherAdminId: string;
let customerId: string;
let sign: (p: { sub: string; role: "admin" | "advertiser"; testOwner?: string }) => string;
let issueTokens: (u: { id: string; role: string; testOwnerId?: string | null }) => Promise<{ accessToken: string; refreshToken: string }>;
let verify: (t: string) => { sub: string; role: string; testOwner?: string };

async function newUser(email: string, role: "admin" | "advertiser"): Promise<string> {
  const r = await pg.query<{ id: string }>(`insert into users (email, password_hash, role) values ($1, 'x', $2) returning id`, [email, role]);
  return r.rows[0]!.id;
}

beforeAll(async () => {
  pg = new PGlite();
  const dir = join(__dirname, "../../drizzle");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    await pg.exec(readFileSync(join(dir, f), "utf8").replaceAll("--> statement-breakpoint", ""));
  }
  // 0030 is idempotent (runs at every container start).
  await pg.exec(readFileSync(join(dir, "0030_test_customers.sql"), "utf8"));
  holder.db = drizzle(pg, { schema });
  adminId = await newUser("admin@x.test", "admin");
  otherAdminId = await newUser("admin2@x.test", "admin");
  customerId = await newUser("shop@x.test", "advertiser");

  const jwt = await import("../auth/jwt.js");
  sign = jwt.signAccessToken;
  verify = jwt.verifyAccessToken;
  issueTokens = (await import("../auth/session.js")).issueTokens;
  const { authPlugin } = await import("../auth/plugin.js");
  const { authRoutes } = await import("./auth.js");
  const { testCustomerRoutes } = await import("./testCustomers.js");
  const { launchRoutes } = await import("./launch.js");
  const { billingRoutes } = await import("./billing.js");
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(authPlugin);
  await app.register(authRoutes);
  await app.register(testCustomerRoutes);
  await app.register(launchRoutes);
  await app.register(billingRoutes);
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
});

beforeEach(() => {
  holder.launches.length = 0;
  holder.checkouts.length = 0;
});

const call = (method: "GET" | "POST", url: string, token: string, payload?: unknown) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload: payload as object } : {}) });

const adminToken = () => sign({ sub: adminId, role: "admin" });

async function createTestCustomer(token = adminToken(), name = "Lawn Pros"): Promise<string> {
  const res = await call("POST", "/test-customers", token, { name });
  expect(res.statusCode).toBe(201);
  return res.json().id;
}

async function switchInto(id: string, token = adminToken()) {
  const res = await call("POST", `/test-customers/${id}/switch`, token, {});
  expect(res.statusCode).toBe(200);
  return res.json() as { accessToken: string; refreshToken: string };
}

describe("test customers: who may", () => {
  it("a customer cannot list, create or switch (403)", async () => {
    const t = sign({ sub: customerId, role: "advertiser" });
    expect((await call("GET", "/test-customers", t)).statusCode).toBe(403);
    expect((await call("POST", "/test-customers", t, { name: "X" })).statusCode).toBe(403);
    const tc = await createTestCustomer();
    expect((await call("POST", `/test-customers/${tc}/switch`, t, {})).statusCode).toBe(403);
  });

  it("an admin JWT for a demoted user is refused: the DB role decides", async () => {
    const t = sign({ sub: customerId, role: "admin" });
    expect((await call("POST", "/test-customers", t, { name: "X" })).statusCode).toBe(403);
  });

  it("an admin cannot switch into another admin's test customer (404)", async () => {
    const theirs = await createTestCustomer(sign({ sub: otherAdminId, role: "admin" }), "Theirs");
    expect((await call("POST", `/test-customers/${theirs}/switch`, adminToken(), {})).statusCode).toBe(404);
  });

  it("a real customer account cannot be switched into, even by an admin (404)", async () => {
    expect((await call("POST", `/test-customers/${customerId}/switch`, adminToken(), {})).statusCode).toBe(404);
  });
});

describe("test customers: the account", () => {
  it("is an advertiser with a .invalid email, owned by the admin, and cannot log in", async () => {
    const id = await createTestCustomer(adminToken(), "Bright Smiles");
    const { rows } = await pg.query<{ role: string; email: string; test_owner_id: string; business_name: string }>(
      `select role, email, test_owner_id, business_name from users where id = $1`,
      [id],
    );
    expect(rows[0]).toMatchObject({ role: "advertiser", test_owner_id: adminId, business_name: "Bright Smiles" });
    expect(rows[0]!.email).toMatch(/^test-[0-9a-f]+@test\.advault\.invalid$/);
    const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email: rows[0]!.email, password: "x".repeat(10) } });
    expect(login.statusCode).toBe(401);

    const list = (await call("GET", "/test-customers", adminToken())).json();
    expect(list.current).toBeNull();
    expect(list.customers.map((c: { id: string }) => c.id)).toContain(id);
  });
});

describe("switching", () => {
  it("into a test customer: tokens for that user carrying testOwner; /auth/me says so", async () => {
    const id = await createTestCustomer();
    const tokens = await switchInto(id);
    expect(verify(tokens.accessToken)).toMatchObject({ sub: id, role: "advertiser", testOwner: adminId });
    const me = (await call("GET", "/auth/me", tokens.accessToken)).json();
    expect(me).toMatchObject({ id, isTestCustomer: true, role: "advertiser" });

    // Inside, the list is still the admin's, with this one marked current.
    const list = (await call("GET", "/test-customers", tokens.accessToken)).json();
    expect(list.current).toBe(id);
  });

  it("the testOwner claim survives a refresh", async () => {
    const id = await createTestCustomer();
    const tokens = await switchInto(id);
    const res = await app.inject({ method: "POST", url: "/auth/refresh", payload: { refreshToken: tokens.refreshToken } });
    expect(res.statusCode).toBe(200);
    expect(verify(res.json().accessToken)).toMatchObject({ sub: id, testOwner: adminId });
  });

  it("back to admin works only from a testOwner session", async () => {
    // From the admin's own session: nothing to go back to.
    expect((await call("POST", "/test-customers/back", adminToken(), {})).statusCode).toBe(403);
    // From a real customer's session.
    expect((await call("POST", "/test-customers/back", sign({ sub: customerId, role: "advertiser" }), {})).statusCode).toBe(403);
    // A forged claim on a real customer's token: the row has no test_owner_id.
    const forged = sign({ sub: customerId, role: "advertiser", testOwner: adminId });
    expect((await call("POST", "/test-customers/back", forged, {})).statusCode).toBe(403);

    const id = await createTestCustomer();
    const tokens = await switchInto(id);
    // A claim naming a different admin than the row's owner.
    const wrongOwner = sign({ sub: id, role: "advertiser", testOwner: otherAdminId });
    expect((await call("POST", "/test-customers/back", wrongOwner, {})).statusCode).toBe(403);

    const back = await call("POST", "/test-customers/back", tokens.accessToken, { refreshToken: tokens.refreshToken });
    expect(back.statusCode).toBe(200);
    const payload = verify(back.json().accessToken);
    expect(payload).toMatchObject({ sub: adminId, role: "admin" });
    expect(payload.testOwner).toBeUndefined();
    // The test customer's session was ended.
    const old = await app.inject({ method: "POST", url: "/auth/refresh", payload: { refreshToken: tokens.refreshToken } });
    expect(old.statusCode).toBe(401);
  });

  it("a demoted owner's test customer session can no longer refresh or go back", async () => {
    const lead = await newUser(`lead-${Date.now()}@x.test`, "admin");
    const id = await createTestCustomer(sign({ sub: lead, role: "admin" }), "Soon gone");
    const tokens = await switchInto(id, sign({ sub: lead, role: "admin" }));
    await pg.query(`update users set role = 'advertiser' where id = $1`, [lead]);
    expect((await call("POST", "/test-customers/back", tokens.accessToken, {})).statusCode).toBe(403);
    const res = await app.inject({ method: "POST", url: "/auth/refresh", payload: { refreshToken: tokens.refreshToken } });
    expect(res.statusCode).toBe(401);
  });
});

describe("test mode for a test customer", () => {
  it("billingIdentity: test mode, not exempt, advertiser, test customer", async () => {
    const { billingIdentity } = await import("../lib/testMode/index.js");
    const id = await createTestCustomer();
    expect(await billingIdentity(id)).toMatchObject({ role: "advertiser", testMode: true, exempt: false, testCustomer: true });
    expect(await billingIdentity(customerId)).toMatchObject({ testMode: false, testCustomer: false });
  });

  it("is charged the $0.50 test price for a $10 ad", async () => {
    const { chargeMinor } = await import("../lib/pricing/index.js");
    const { billingIdentity } = await import("../lib/testMode/index.js");
    const id = await createTestCustomer();
    expect(chargeMinor(1000, (await billingIdentity(id)).testMode)).toBe(50);
    expect(chargeMinor(1000, (await billingIdentity(customerId)).testMode)).toBe(1000);
  });
});

describe("launch", () => {
  async function launchable(userId: string) {
    const c = await pg.query<{ id: string }>(
      `insert into campaigns (user_id, name, business_name, business_category, target_zip_codes, daily_budget_cents, landing_url)
       values ($1, 'Spring', 'Lawn Pros', 'landscaping', '{08817}', 1000, 'https://lawn.example') returning id`,
      [userId],
    );
    const campaignId = c.rows[0]!.id;
    await pg.query(
      `insert into creatives (campaign_id, aspect_ratio, render_status, youtube_video_id, script)
       values ($1, '16:9', 'ready', 'abcdefghijk', '{}'::jsonb)`,
      [campaignId],
    );
    await pg.query(
      `insert into assets (user_id, kind, r2_key, content_type) values ($1, 'logo', $2, 'image/png')`,
      [userId, `logos/${campaignId}.png`],
    );
    // A platform account still waiting for its card: a real launch is refused
    // (billing_setup_pending), a dry run is not.
    const a = await pg.query<{ id: string }>(
      `insert into ad_accounts (user_id, provider, customer_id, currency_code, is_managed, billing_mode, billing_link_status,
         login_customer_id, manager_customer_id, status, provision_status)
       values ($1, 'google_ads', '1234567890', 'USD', true, 'platform', 'pending', '999', '999', 'active', 'active') returning id`,
      [userId],
    );
    return { campaignId, adAccountId: a.rows[0]!.id };
  }

  it("a test customer's launch is a dry run, whatever the request says", async () => {
    const id = await createTestCustomer();
    const { accessToken } = await switchInto(id);
    const { campaignId, adAccountId } = await launchable(id);
    const res = await call("POST", `/campaigns/${campaignId}/launch`, accessToken, { adAccountId, validateOnly: false });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ validateOnly: true, ok: true, testCustomer: true });
    expect(holder.launches).toEqual([{ validateOnly: true }]);
    const { rows } = await pg.query<{ status: string; launched_at: Date | null }>(`select status, launched_at from campaigns where id = $1`, [campaignId]);
    expect(rows[0]).toMatchObject({ status: "draft", launched_at: null });
  });

  it("the same request from a real customer is a real launch (refused here: no plan)", async () => {
    const shop = await newUser(`shop-${Date.now()}@x.test`, "advertiser");
    const { campaignId, adAccountId } = await launchable(shop);
    const res = await call("POST", `/campaigns/${campaignId}/launch`, sign({ sub: shop, role: "advertiser" }), { adAccountId, validateOnly: false });
    expect(res.statusCode).toBe(402);
    expect(res.json().error).toBe("plan_required");
    expect(holder.launches).toEqual([]);
  });
});

describe("ad budget top-up", () => {
  it("a test customer is charged (and credited) the $0.50 test price, tagged test", async () => {
    const { accessToken } = await switchInto(await createTestCustomer(adminToken(), "Top-up Test"));
    const res = await call("POST", "/wallet/topup", accessToken, { amountMinor: 10_000 });
    expect(res.statusCode).toBe(201);
    expect(holder.checkouts).toEqual([expect.objectContaining({ amountMinor: 50, testMode: true })]);
    const row = await pg.query<{ amount_minor: number }>(`select amount_minor from payments where id = $1`, [res.json().paymentId]);
    expect(Number(row.rows[0]!.amount_minor)).toBe(50);
  });

  it("a real customer pays the amount asked for", async () => {
    const res = await call("POST", "/wallet/topup", sign({ sub: customerId, role: "advertiser" }), { amountMinor: 10_000 });
    expect(res.statusCode, res.body).toBe(201);
    expect(holder.checkouts).toEqual([expect.objectContaining({ amountMinor: 10_000, testMode: false })]);
  });
});

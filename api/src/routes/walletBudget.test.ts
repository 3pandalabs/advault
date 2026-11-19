// Top-up-first model (2026-11-19): GET /wallet's budget picture (the banners),
// a top-up started on a campaign page returning there, and a top-up restarting
// a campaign the empty wallet paused (lib/billing/resume.ts), on PGlite.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../db/schema.js";

const holder = vi.hoisted(() => {
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
    enableCampaign: vi.fn(async () => undefined),
    createCheckout: vi.fn(async (_req: { returnUrl: string }) => ({
      providerRef: `cs_test_${Math.random()}`,
      redirectUrl: "https://checkout.invalid",
      clientPayload: {},
    })),
  };
});

vi.mock("../db/index.js", () => ({
  get db() {
    return holder.db;
  },
}));

vi.mock("../auth/plugin.js", () => ({
  requireAuth: async (req: FastifyRequest, reply: FastifyReply) => {
    const id = req.headers["x-test-user"];
    if (typeof id !== "string") return reply.code(401).send({ error: "unauthorized" });
    (req as FastifyRequest & { userId?: string }).userId = id;
    req.userRole = "advertiser";
  },
  requireAdmin: async (_req: FastifyRequest, reply: FastifyReply) => {
    reply.code(403).send({ error: "admin_role_required" });
  },
}));

vi.mock("../lib/googleAds/mcc.js", async (orig) => ({
  ...(await orig<typeof import("../lib/googleAds/mcc.js")>()),
  isMccConfigured: () => true,
  mccAccessToken: async () => "token",
  enableCampaign: holder.enableCampaign,
}));

vi.mock("../lib/payments/index.js", async (orig) => ({
  ...(await orig<typeof import("../lib/payments/index.js")>()),
  providerFor: () => ({ name: "stripe", createCheckout: holder.createCheckout }),
}));

let app: FastifyInstance;
let pg: PGlite;
let userId: string;
let otherUserId: string;
let accountId: string;

async function newUser(email: string): Promise<string> {
  const r = await pg.query<{ id: string }>(
    `insert into users (email, password_hash, role) values ($1, 'x', 'advertiser') returning id`,
    [email],
  );
  return r.rows[0]!.id;
}

async function campaign(opts: { status: string; dailyCents?: number; pausedForFunds?: boolean; owner?: string }) {
  const r = await pg.query<{ id: string }>(
    `insert into campaigns (user_id, name, business_name, business_category, target_zip_codes, daily_budget_cents,
       currency_code, landing_url, status, ad_account_id, google_campaign_resource_name, paused_for_funds_at)
     values ($1, 'c', 'Joe', 'Plumbing', '{10001}', $2, 'USD', 'https://example.com', $3, $4,
       'customers/1234567890/campaigns/1', $5) returning id`,
    [opts.owner ?? userId, opts.dailyCents ?? 500, opts.status, accountId, opts.pausedForFunds ? new Date() : null],
  );
  return r.rows[0]!.id;
}

async function setBalance(minor: number) {
  await pg.query(
    `insert into wallets (user_id, currency_code, balance_minor) values ($1, 'USD', $2)
     on conflict (user_id) do update set balance_minor = excluded.balance_minor`,
    [userId, minor],
  );
}

const getWallet = async () =>
  (await app.inject({ method: "GET", url: "/wallet", headers: { "x-test-user": userId } })).json();

beforeAll(async () => {
  pg = new PGlite();
  const dir = join(__dirname, "../../drizzle");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    await pg.exec(readFileSync(join(dir, f), "utf8").replaceAll("--> statement-breakpoint", ""));
  }
  holder.db = drizzle(pg, { schema });
  userId = await newUser("shop@x.test");
  otherUserId = await newUser("other@x.test");
  const a = await pg.query<{ id: string }>(
    `insert into ad_accounts (user_id, provider, customer_id, currency_code, is_managed, billing_mode, billing_link_status,
       login_customer_id, manager_customer_id, status, provision_status)
     values ($1, 'google_ads', '1234567890', 'USD', true, 'platform', 'active', '999', '999', 'active', 'active') returning id`,
    [userId],
  );
  accountId = a.rows[0]!.id;

  const { billingRoutes } = await import("./billing.js");
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(billingRoutes);
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
});

beforeEach(async () => {
  await pg.query(`delete from campaigns`);
  holder.enableCampaign.mockClear();
});

describe("GET /wallet budget", () => {
  it("is idle with nothing launched", async () => {
    await setBalance(5_000);
    expect((await getWallet()).budget).toMatchObject({ state: "idle", daysLeft: null, pausedForFunds: [] });
  });

  it("estimates days left from the live campaigns' daily budgets", async () => {
    await setBalance(5_000);
    const id = await campaign({ status: "live" });
    expect((await getWallet()).budget).toMatchObject({
      state: "ok",
      daysLeft: 10,
      liveDailyMinor: 500,
      liveCampaignIds: [id],
    });
  });

  it("is low under max(2 days, $10)", async () => {
    await setBalance(900);
    await campaign({ status: "live" });
    expect((await getWallet()).budget).toMatchObject({ state: "low", daysLeft: 1 });
  });

  it("is empty when the wallet paused a campaign", async () => {
    await setBalance(0);
    const id = await campaign({ status: "paused", pausedForFunds: true });
    expect((await getWallet()).budget).toMatchObject({ state: "empty", pausedForFunds: [{ id }] });
  });

  it("ignores a campaign paused for another reason", async () => {
    await setBalance(0);
    await campaign({ status: "paused" });
    expect((await getWallet()).budget.state).toBe("idle");
  });
});

describe("POST /wallet/topup", () => {
  it("returns to the campaign page for the owner's campaign, else the wallet", async () => {
    const id = await campaign({ status: "live" });
    const other = await campaign({ status: "live", owner: otherUserId });
    const cases: [string | undefined, string][] = [
      [id, `/dashboard/campaigns/${id}`],
      [other, "/dashboard/wallet"],
      [undefined, "/dashboard/wallet"],
    ];
    for (const [campaignId, expected] of cases) {
      holder.createCheckout.mockClear();
      const res = await app.inject({
        method: "POST",
        url: "/wallet/topup",
        headers: { "x-test-user": userId },
        payload: { amountMinor: 5_000, ...(campaignId ? { campaignId } : {}) },
      });
      expect(res.statusCode).toBe(201);
      expect(holder.createCheckout.mock.calls[0]![0].returnUrl.endsWith(expected)).toBe(true);
    }
  });
});

describe("POST /wallet/topup minimum (server side)", () => {
  const topup = (user: string, payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: "/wallet/topup", headers: { "x-test-user": user }, payload });

  it("refuses an ad budget top-up under $35 before any checkout", async () => {
    holder.createCheckout.mockClear();
    const res = await topup(userId, { amountMinor: 3_499 });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "topup_below_minimum", minMinor: 3_500, currencyCode: "USD" });
    expect(res.json().detail).toContain("$35");
    expect(holder.createCheckout).not.toHaveBeenCalled();
    const n = await pg.query<{ n: number }>(`select count(*)::int as n from payments where user_id = $1 and amount_minor = 3499`, [userId]);
    expect(n.rows[0]!.n).toBe(0);
  });

  it("accepts exactly $35", async () => {
    holder.createCheckout.mockClear();
    const res = await topup(userId, { amountMinor: 3_500 });
    expect(res.statusCode).toBe(201);
    expect(holder.createCheckout.mock.calls[0]![0]).toMatchObject({ amountMinor: 3_500 });
  });

  it("does not apply to a creation fee", async () => {
    holder.createCheckout.mockClear();
    const res = await topup(userId, { amountMinor: 1_000, purpose: "creation_fee" });
    expect(res.statusCode).toBe(201);
  });

  it("test mode: validates the requested amount, then charges 50 cents", async () => {
    const r = await pg.query<{ id: string }>(
      `insert into users (email, password_hash, role, test_as_customer) values ('admin-test@x.invalid', 'x', 'admin', true) returning id`,
    );
    const admin = r.rows[0]!.id;
    holder.createCheckout.mockClear();
    expect((await topup(admin, { amountMinor: 50 })).statusCode).toBe(400);
    const ok = await topup(admin, { amountMinor: 3_500 });
    expect(ok.statusCode).toBe(201);
    expect(holder.createCheckout.mock.calls[0]![0]).toMatchObject({ amountMinor: 50, testMode: true });
  });
});

describe("resumeFundedCampaigns", () => {
  it("restarts a paused-for-funds campaign once the balance covers 3 days", async () => {
    const { resumeFundedCampaigns } = await import("../lib/billing/resume.js");
    const id = await campaign({ status: "paused", pausedForFunds: true });

    await setBalance(1_000); // under 3 x $5
    expect(await resumeFundedCampaigns(userId)).toBe(0);
    expect(holder.enableCampaign).not.toHaveBeenCalled();

    await setBalance(3_500);
    expect(await resumeFundedCampaigns(userId)).toBe(1);
    expect(holder.enableCampaign).toHaveBeenCalledOnce();
    const row = await pg.query<{ status: string; paused_for_funds_at: Date | null }>(
      `select status, paused_for_funds_at from campaigns where id = $1`,
      [id],
    );
    expect(row.rows[0]).toEqual({ status: "live", paused_for_funds_at: null });
  });

  it("never restarts a campaign paused for another reason", async () => {
    const { resumeFundedCampaigns } = await import("../lib/billing/resume.js");
    await campaign({ status: "paused" });
    await setBalance(10_000);
    expect(await resumeFundedCampaigns(userId)).toBe(0);
    expect(holder.enableCampaign).not.toHaveBeenCalled();
  });
});

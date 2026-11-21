// GET /campaigns/stats (2026-11-20): the dashboard list's stats row. Owner's
// launched campaigns only, totals since launch in one query, null totals
// before Google's first numbers, and walletPays from the ad account's billing.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
  return { db: null as unknown };
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

let app: FastifyInstance;
let pg: PGlite;
let userId: string;
let otherUserId: string;

const today = new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

async function newUser(email: string): Promise<string> {
  const r = await pg.query<{ id: string }>(
    `insert into users (email, password_hash, role) values ($1, 'x', 'advertiser') returning id`,
    [email],
  );
  return r.rows[0]!.id;
}

async function campaign(opts: { launched: boolean; owner?: string; accountId?: string | null }) {
  const r = await pg.query<{ id: string }>(
    `insert into campaigns (user_id, name, business_name, business_category, target_zip_codes, daily_budget_cents,
       currency_code, landing_url, status, ad_account_id, google_campaign_resource_name, launched_at)
     values ($1, 'c', 'Joe', 'Plumbing', '{10001}', 500, 'USD', 'https://example.com', $2, $3, $4, $5) returning id`,
    [
      opts.owner ?? userId,
      opts.launched ? "live" : "draft",
      opts.accountId ?? null,
      opts.launched ? "customers/1/campaigns/2" : null,
      opts.launched ? new Date(Date.now() - 40 * 86_400_000) : null,
    ],
  );
  return r.rows[0]!.id;
}

beforeAll(async () => {
  pg = new PGlite();
  const dir = join(__dirname, "../../drizzle");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    await pg.exec(readFileSync(join(dir, f), "utf8").replaceAll("--> statement-breakpoint", ""));
  }
  holder.db = drizzle(pg, { schema });
  userId = await newUser("shop@x.test");
  otherUserId = await newUser("other@x.test");

  const { adMetricsRoutes } = await import("./adMetrics.js");
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(adMetricsRoutes);
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
});

const stats = (user = userId) =>
  app.inject({ method: "GET", url: "/campaigns/stats", headers: { "x-test-user": user } });

describe("GET /campaigns/stats", () => {
  it("needs a session", async () => {
    expect((await app.inject({ method: "GET", url: "/campaigns/stats" })).statusCode).toBe(401);
  });

  it("lists only the caller's launched campaigns, summed since launch", async () => {
    const acct = await pg.query<{ id: string }>(
      `insert into ad_accounts (user_id, provider, customer_id, currency_code, is_managed, billing_mode, billing_link_status,
         login_customer_id, manager_customer_id, status, provision_status)
       values ($1, 'google_ads', '1234567890', 'USD', true, 'platform', 'active', '999', '999', 'active', 'active') returning id`,
      [userId],
    );
    const withData = await campaign({ launched: true, accountId: acct.rows[0]!.id });
    const waiting = await campaign({ launched: true });
    const draft = await campaign({ launched: false });
    const others = await campaign({ launched: true, owner: otherUserId });
    await pg.query(
      `insert into campaign_daily_metrics (campaign_id, date, impressions, views, clicks, cost_micros) values
         ($1, $2, 1000, 150, 5, 6000000), ($1, $3, 800, 100, 3, 4000000), ($1, $4, 999, 999, 9, 9000000),
         ($5, $2, 50, 5, 1, 1000000)`,
      [withData, daysAgo(1), today, daysAgo(20), others],
    );

    const res = await stats();
    expect(res.statusCode).toBe(200);
    const body = res.json() as { note: string; campaigns: { campaignId: string; lastSyncedAt?: string | null }[] };
    expect(body.note).toMatch(/lag/);
    const ids = body.campaigns.map((c) => c.campaignId).sort();
    expect(ids).toEqual([withData, waiting].sort());
    expect(ids).not.toContain(draft);
    expect(ids).not.toContain(others);

    const a = body.campaigns.find((c) => c.campaignId === withData);
    expect(a).toMatchObject({
      currency: "USD",
      walletPays: true,
      totals: { impressions: 2799, views: 1249, clicks: 17, spendMinor: 1900, spendDisplay: "$19" },
    });
    expect(typeof a?.lastSyncedAt).toBe("string");

    expect(body.campaigns.find((c) => c.campaignId === waiting)).toEqual({
      campaignId: waiting,
      currency: "USD",
      walletPays: false,
      lastSyncedAt: null,
      totals: null,
    });
  });

  it("is empty for someone with nothing launched", async () => {
    const u = await newUser("fresh@x.test");
    expect((await stats(u)).json()).toEqual({ note: expect.any(String), campaigns: [] });
  });
});

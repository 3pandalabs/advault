// GET /campaigns/:id/results (2026-11-19): owner only, not-launched shape,
// totals / cost per view and click / balance, breakdowns from stored segment
// rows, and "Not enough views yet" (null) when Google reported nothing.
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

const get = (id: string, range = "7d", user = userId) =>
  app.inject({ method: "GET", url: `/campaigns/${id}/results?range=${range}`, headers: { "x-test-user": user } });

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

describe("GET /campaigns/:id/results", () => {
  it("is owner only", async () => {
    const id = await campaign({ launched: true });
    expect((await get(id, "7d", otherUserId)).statusCode).toBe(404);
    expect((await get(id, "bogus")).statusCode).toBe(400);
  });

  it("says not launched before launch", async () => {
    const id = await campaign({ launched: false });
    expect((await get(id)).json()).toEqual({ campaignId: id, launched: false, range: "7d" });
  });

  it("with nothing reported yet: no totals and every breakdown null", async () => {
    const id = await campaign({ launched: true });
    const body = (await get(id)).json();
    expect(body).toMatchObject({ launched: true, range: "7d", totals: null, balance: null, trend: [] });
    expect(Object.values(body.breakdowns).every((b) => b === null)).toBe(true);
  });

  it("totals, wallet balance, breakdowns and ranges from stored rows", async () => {
    const acct = await pg.query<{ id: string }>(
      `insert into ad_accounts (user_id, provider, customer_id, currency_code, is_managed, billing_mode, billing_link_status,
         login_customer_id, manager_customer_id, status, provision_status)
       values ($1, 'google_ads', '1234567890', 'USD', true, 'platform', 'active', '999', '999', 'active', 'active') returning id`,
      [userId],
    );
    await pg.query(`insert into wallets (user_id, currency_code, balance_minor) values ($1, 'USD', 5000)`, [userId]);
    const id = await campaign({ launched: true, accountId: acct.rows[0]!.id });
    await pg.query(
      `insert into campaign_daily_metrics (campaign_id, date, impressions, views, clicks, cost_micros) values
         ($1, $2, 1000, 150, 5, 6000000), ($1, $3, 800, 100, 3, 4000000), ($1, $4, 999, 999, 9, 9000000)`,
      [id, daysAgo(1), today, daysAgo(20)],
    );
    await pg.query(
      `insert into campaign_segment_metrics (campaign_id, date, dimension, segment, label, impressions, views, clicks, cost_micros) values
         ($1, $2, 'device', 'MOBILE', null, 900, 120, 4, 5000000),
         ($1, $2, 'device', 'CONNECTED_TV', null, 100, 30, 1, 1000000),
         ($1, $2, 'postal', 'geoTargetConstants/9031934', '10001, New York', 500, 80, 2, 3000000),
         ($1, $2, 'hour', '0', null, 10, 1, 0, 0),
         ($1, $3, 'device', 'DESKTOP', null, 50, 5, 0, 0)`,
      [id, daysAgo(1), daysAgo(20)],
    );

    const week = (await get(id)).json();
    expect(week.totals).toMatchObject({
      views: 250,
      clicks: 8,
      spendMinor: 1_000,
      costPerViewDisplay: "$0.04",
      costPerClickDisplay: "$1.25",
    });
    expect(week.trend).toHaveLength(2);
    // $50 at the recent pace of $5/day.
    expect(week.balance).toEqual({ balanceMinor: 5_000, display: "$50", daysLeft: 10 });
    expect(week.breakdowns.device.map((d: { label: string }) => d.label)).toEqual(["Phones", "TV screens"]);
    expect(week.breakdowns.location[0].label).toBe("10001, New York");
    expect(week.breakdowns.hour[0].label).toBe("12am");
    expect(week.breakdowns.age).toBeNull();
    expect(week.breakdowns.dayOfWeek).toHaveLength(2);

    const all = (await get(id, "all")).json();
    expect(all.totals.views).toBe(1_249);
    expect(all.breakdowns.device.map((d: { label: string }) => d.label)).toContain("Computers");
  });
});

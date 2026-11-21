// Ad click tracking (2026-11-21, migration 0045): POST /track/visit counts a
// visit per (campaign, day, path) with no IP / user agent stored, unknown ids
// are ignored with the same 204, POST /auth/register records the campaign
// that brought the account, and GET /admin/metrics + GET /campaigns/stats
// surface the numbers (the latter only for ads landing on our own site).
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

vi.mock("../auth/adminAccess.js", () => ({
  requireAdminOrAnalyticsToken: async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.headers["x-test-admin"] !== "1") return reply.code(403).send({ error: "admin_role_required" });
  },
}));

let app: FastifyInstance;
let pg: PGlite;
let ownerId: string;
let ourAd: string; // lands on advault.3pandalabs.com
let customerAd: string; // lands on a SiteVault site (invisible to us)

const UNKNOWN = "00000000-0000-4000-8000-000000000000";

async function campaign(landingUrl: string) {
  const r = await pg.query<{ id: string }>(
    `insert into campaigns (user_id, name, business_name, business_category, target_zip_codes, daily_budget_cents,
       currency_code, landing_url, status, google_campaign_resource_name, launched_at)
     values ($1, 'c', 'Joe', 'Plumbing', '{10001}', 500, 'USD', $2, 'live', 'customers/1/campaigns/2', now()) returning id`,
    [ownerId, landingUrl],
  );
  return r.rows[0]!.id;
}

const visit = (payload: object, ip = "203.0.113.1") =>
  app.inject({ method: "POST", url: "/track/visit", payload, remoteAddress: ip });

const sql = (dir: string, f: string) => readFileSync(join(dir, f), "utf8").replaceAll("--> statement-breakpoint", "");

beforeAll(async () => {
  pg = new PGlite();
  const dir = join(__dirname, "../../drizzle");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) await pg.exec(sql(dir, f));
  // 0045 again: must be idempotent (migrations run at every container start).
  await pg.exec(sql(dir, "0045_ad_site_visits.sql"));
  holder.db = drizzle(pg, { schema });
  const u = await pg.query<{ id: string }>(
    `insert into users (email, password_hash, role) values ('owner@x.test', 'x', 'advertiser') returning id`,
  );
  ownerId = u.rows[0]!.id;
  ourAd = await campaign("https://advault.3pandalabs.com/?utm_source=youtube");
  customerAd = await campaign("https://joes.3pandasite.com");

  const { siteVisitRoutes } = await import("./siteVisits.js");
  const { authRoutes } = await import("./auth.js");
  const { adMetricsRoutes } = await import("./adMetrics.js");
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(siteVisitRoutes);
  await app.register(authRoutes);
  await app.register(adMetricsRoutes);
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
});

describe("POST /track/visit", () => {
  it("counts per campaign/day/path, keeping only the pathname", async () => {
    expect((await visit({ campaignId: ourAd, path: "/" })).statusCode).toBe(204);
    expect((await visit({ campaignId: ourAd.toUpperCase(), path: "/?x=secret" })).statusCode).toBe(204);
    expect((await visit({ campaignId: ourAd, path: "/signup" })).statusCode).toBe(204);
    const rows = await pg.query<{ path: string; visits: number }>(
      `select path, visits from campaign_site_visits where campaign_id = $1 order by path`,
      [ourAd],
    );
    expect(rows.rows).toEqual([
      { path: "/", visits: 2 },
      { path: "/signup", visits: 1 },
    ]);
  });

  it("stores no IP or user agent (the table has no such column)", async () => {
    const cols = await pg.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_name = 'campaign_site_visits' order by column_name`,
    );
    expect(cols.rows.map((c) => c.column_name)).toEqual(["campaign_id", "day", "path", "visits"]);
  });

  it("ignores unknown or malformed ids with the same 204", async () => {
    expect((await visit({ campaignId: UNKNOWN, path: "/" })).statusCode).toBe(204);
    expect((await visit({ campaignId: "summer-sale", path: "/" })).statusCode).toBe(204);
    const n = await pg.query<{ n: number }>(
      `select count(*)::int as n from campaign_site_visits where campaign_id <> $1`,
      [ourAd],
    );
    expect(n.rows[0]!.n).toBe(0);
  });

  it("rate-limits one IP (still 204, not counted)", async () => {
    for (let i = 0; i < 40; i++) await visit({ campaignId: customerAd, path: "/" }, "198.51.100.9");
    const r = await pg.query<{ visits: number }>(`select visits from campaign_site_visits where campaign_id = $1`, [
      customerAd,
    ]);
    expect(r.rows[0]!.visits).toBe(30);
  });
});

describe("POST /auth/register with adCampaignId", () => {
  const reg = (email: string, adCampaignId?: string) =>
    app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email, password: "long-enough-pw", ...(adCampaignId ? { adCampaignId } : {}) },
    });
  const campaignOf = async (email: string) =>
    (await pg.query<{ c: string | null }>(`select signup_campaign_id as c from users where email = $1`, [email]))
      .rows[0]!.c;

  it("records a known campaign", async () => {
    expect((await reg("fromad@x.test", ourAd)).statusCode).toBe(201);
    expect(await campaignOf("fromad@x.test")).toBe(ourAd);
  });

  it("ignores an unknown or malformed id and still signs up", async () => {
    expect((await reg("unknown@x.test", UNKNOWN)).statusCode).toBe(201);
    expect(await campaignOf("unknown@x.test")).toBeNull();
    expect((await reg("junk@x.test", "nope")).statusCode).toBe(201);
    expect(await campaignOf("junk@x.test")).toBeNull();
    expect((await reg("plain@x.test")).statusCode).toBe(201);
    expect(await campaignOf("plain@x.test")).toBeNull();
  });
});

describe("surfacing", () => {
  it("GET /admin/metrics carries siteVisits and signups per campaign and in totals", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/metrics?days=7", headers: { "x-test-admin": "1" } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      totals: Record<string, { siteVisits: number; signups: number; impressions: number }>;
      campaigns: { campaignId: string; totals: { siteVisits: number; signups: number } }[];
    };
    expect(body.campaigns.find((c) => c.campaignId === ourAd)?.totals).toMatchObject({ siteVisits: 3, signups: 1 });
    expect(body.campaigns.find((c) => c.campaignId === customerAd)?.totals).toMatchObject({
      siteVisits: 30,
      signups: 0,
    });
    expect(body.totals.USD).toMatchObject({ siteVisits: 33, signups: 1, impressions: 0 });
  });

  it("GET /campaigns/stats shows visits only for ads landing on advault.3pandalabs.com", async () => {
    const res = await app.inject({ method: "GET", url: "/campaigns/stats", headers: { "x-test-user": ownerId } });
    const list = (res.json() as { campaigns: { campaignId: string; siteVisits: number | null }[] }).campaigns;
    expect(list.find((c) => c.campaignId === ourAd)?.siteVisits).toBe(3);
    expect(list.find((c) => c.campaignId === customerAd)?.siteVisits).toBeNull();
  });
});

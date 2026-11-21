// PUT /campaigns/:id/targeting (2026-11-20): saved on the row before launch,
// applied at Google first after launch, housing rules kept. PGlite; Google's
// REST client is stubbed so the exact mutate is asserted.
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
    searchRows: {} as Record<string, unknown[]>,
    mutateError: null as Error | null,
    calls: [] as { path: string; body: { query?: string; mutateOperations?: unknown[] } }[],
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
  requireAdmin: async (_req: FastifyRequest, reply: FastifyReply) => reply.code(403).send({ error: "admin_role_required" }),
}));

vi.mock("../lib/googleAds/env.js", async (orig) => ({
  ...(await orig<typeof import("../lib/googleAds/env.js")>()),
  isGoogleAdsConfigured: () => true,
}));

vi.mock("../lib/googleAds/mcc.js", async (orig) => ({
  ...(await orig<typeof import("../lib/googleAds/mcc.js")>()),
  mccAccessToken: async () => "token",
}));

vi.mock("../lib/googleAds/client.js", async (orig) => {
  const real = await orig<typeof import("../lib/googleAds/client.js")>();
  return {
    ...real,
    googleAdsCall: async (
      path: string,
      _token: string,
      init: { body: { query?: string; mutateOperations?: unknown[] } },
    ) => {
      holder.calls.push({ path, body: init.body });
      if (path.endsWith(":search")) {
        const q = init.body.query ?? "";
        const key = q.includes("FROM ad_group_criterion")
          ? "adGroup"
          : q.includes("FROM campaign_criterion")
            ? "campaignCriteria"
            : "campaign";
        return { results: holder.searchRows[key] ?? [] };
      }
      if (holder.mutateError) throw holder.mutateError;
      return {
        mutateOperationResponses: [{ audienceResult: { resourceName: "customers/1234567890/audiences/4242" } }, {}],
      };
    },
  };
});

let app: FastifyInstance;
let pg: PGlite;
let userId: string;
let otherId: string;
let accountId: string;

async function newUser(email: string): Promise<string> {
  const r = await pg.query<{ id: string }>(
    `insert into users (email, password_hash, role) values ($1, 'x', 'advertiser') returning id`,
    [email],
  );
  return r.rows[0]!.id;
}

async function campaign(opts: { launched: boolean; category?: string; filters?: unknown; status?: string }) {
  const housing = (opts.category ?? "Plumbing") === "Real estate";
  const r = await pg.query<{ id: string }>(
    `insert into campaigns (user_id, name, business_name, business_category, target_zip_codes, target_address, daily_budget_cents,
       currency_code, landing_url, status, ad_account_id, google_customer_id, google_campaign_resource_name, google_ad_group_resource_name, audience_filters)
     values ($1, 'c', 'Joe', $2, $3, $4, 500, 'USD', 'https://example.com', $5, $6, $7, $8, $9, $10) returning id`,
    [
      userId,
      opts.category ?? "Plumbing",
      housing ? "{}" : "{10001}",
      housing ? JSON.stringify({ street: "1 Main St", city: "Edison", state: "NJ", postalCode: "08817" }) : null,
      opts.status ?? (opts.launched ? "live" : "draft"),
      opts.launched ? accountId : null,
      opts.launched ? "1234567890" : null,
      opts.launched ? "customers/1234567890/campaigns/5" : null,
      opts.launched ? "customers/1234567890/adGroups/6" : null,
      opts.filters ? JSON.stringify(opts.filters) : null,
    ],
  );
  return r.rows[0]!.id;
}

const put = (id: string, payload: unknown, user = userId) =>
  app.inject({
    method: "PUT",
    url: `/campaigns/${id}/targeting`,
    headers: { "x-test-user": user },
    payload: payload as object,
  });

const row = async (id: string) =>
  (
    await pg.query<{ audience_filters: unknown; google_audience_resource_name: string | null }>(
      `select audience_filters, google_audience_resource_name from campaigns where id = $1`,
      [id],
    )
  ).rows[0]!;

const mutates = () => holder.calls.filter((c) => c.path.endsWith(":mutate"));

beforeAll(async () => {
  pg = new PGlite();
  const dir = join(__dirname, "../../drizzle");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    await pg.exec(readFileSync(join(dir, f), "utf8").replaceAll("--> statement-breakpoint", ""));
  }
  holder.db = drizzle(pg, { schema });
  userId = await newUser("shop@x.test");
  otherId = await newUser("other@x.test");
  const a = await pg.query<{ id: string }>(
    `insert into ad_accounts (user_id, provider, customer_id, currency_code, is_managed, billing_mode, billing_link_status,
       login_customer_id, manager_customer_id, status, provision_status)
     values ($1, 'google_ads', '1234567890', 'USD', true, 'platform', 'active', '999', '999', 'active', 'active') returning id`,
    [userId],
  );
  accountId = a.rows[0]!.id;

  const { targetingRoutes } = await import("./targeting.js");
  const { campaignRoutes } = await import("./campaigns.js");
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(targetingRoutes);
  await app.register(campaignRoutes);
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app.close();
  await pg.close();
});

beforeEach(() => {
  holder.calls = [];
  holder.searchRows = {};
  holder.mutateError = null;
});

describe("PUT /campaigns/:id/targeting", () => {
  it("before launch: saves the normalised filters, never calls Google", async () => {
    const id = await campaign({ launched: false });
    const res = await put(id, { audienceFilters: { ages: ["35-44"], languages: [] } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ appliedAtGoogle: false });
    expect((await row(id)).audience_filters).toEqual({ ages: ["35-44"] });
    expect(holder.calls).toHaveLength(0);
  });

  it("live: updates the Audience at Google, then the row", async () => {
    const id = await campaign({ launched: true, filters: { ages: ["25-34"] } });
    holder.searchRows.adGroup = [
      {
        adGroupCriterion: {
          resourceName: "customers/1234567890/adGroupCriteria/6~77",
          type: "AUDIENCE",
          audience: { audience: "customers/1234567890/audiences/88" },
        },
      },
    ];
    const res = await put(id, { audienceFilters: { ages: ["35-44"] } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ appliedAtGoogle: true, changedAtGoogle: true });
    expect(mutates()).toHaveLength(1);
    expect(mutates()[0]!.body.mutateOperations).toEqual([
      {
        audienceOperation: {
          update: {
            resourceName: "customers/1234567890/audiences/88",
            dimensions: [{ age: { ageRanges: [{ minAge: 35, maxAge: 44 }], includeUndetermined: false } }],
          },
          updateMask: "dimensions",
        },
      },
    ]);
    expect(await row(id)).toEqual({
      audience_filters: { ages: ["35-44"] },
      google_audience_resource_name: "customers/1234567890/audiences/88",
    });
  });

  it("paused-but-launched counts as launched; a new Audience's name is stored", async () => {
    const id = await campaign({ launched: true, status: "paused" });
    const res = await put(id, { audienceFilters: { genders: ["female"] } });
    expect(res.statusCode).toBe(200);
    expect(mutates()[0]!.body.mutateOperations).toHaveLength(2);
    expect((await row(id)).google_audience_resource_name).toBe("customers/1234567890/audiences/4242");
  });

  it("Google refuses: 502 with the reason, the row keeps what is serving", async () => {
    const { GoogleAdsApiError } = await import("../lib/googleAds/client.js");
    const id = await campaign({ launched: true, filters: { ages: ["25-34"] } });
    holder.mutateError = new GoogleAdsApiError("bad", 400, [{ errors: [{ message: "Too narrow." }] }]);
    const res = await put(id, { audienceFilters: { ages: ["35-44"] } });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: "google_ads_error" });
    expect(res.json().detail).toContain("Too narrow.");
    expect((await row(id)).audience_filters).toEqual({ ages: ["25-34"] });
  });

  it("no change at Google sends no mutate", async () => {
    const id = await campaign({ launched: true });
    const res = await put(id, { audienceFilters: null });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ appliedAtGoogle: true, changedAtGoogle: false });
    expect(mutates()).toHaveLength(0);
  });

  it("real estate: age / gender / family filters are refused before Google; income is fine", async () => {
    const id = await campaign({ launched: true, category: "Real estate" });
    const res = await put(id, { audienceFilters: { ages: ["35-44"] } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("housing_demographics_not_allowed");
    expect(holder.calls).toHaveLength(0);
    expect((await put(id, { audienceFilters: { incomes: ["top_10"] } })).statusCode).toBe(200);
  });

  it("someone else's campaign is 404", async () => {
    const id = await campaign({ launched: true });
    expect((await put(id, { audienceFilters: null }, otherId)).statusCode).toBe(404);
  });

  it("a taken-down campaign is 409 ad_taken_down, nothing saved, no Google call", async () => {
    const id = await campaign({ launched: true, filters: { ages: ["25-34"] } });
    await pg.query(`update campaigns set compliance_status = 'taken_down' where id = $1`, [id]);
    const res = await put(id, { audienceFilters: null });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "ad_taken_down" });
    expect((await row(id)).audience_filters).toEqual({ ages: ["25-34"] });
    expect(holder.calls).toHaveLength(0);
    expect((await put(id, { adSchedule: null })).statusCode).toBe(409);
  });

  it("an unknown filter key is a 400", async () => {
    const id = await campaign({ launched: false });
    expect((await put(id, { audienceFilters: { gender: ["female"] } })).statusCode).toBe(400);
  });
});

describe("PUT /campaigns/:id/targeting — days and hours", () => {
  const monFri = { days: ["fri", "mon"], startHour: 9, endHour: 17 };

  it("before launch: saved normalised; every day all day is null", async () => {
    const id = await campaign({ launched: false });
    expect((await put(id, { adSchedule: monFri })).statusCode).toBe(200);
    let r = await pg.query<{ ad_schedule: unknown }>(`select ad_schedule from campaigns where id = $1`, [id]);
    expect(r.rows[0]!.ad_schedule).toEqual({ days: ["mon", "fri"], startHour: 9, endHour: 17 });
    await put(id, { adSchedule: { days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], startHour: 0, endHour: 24 } });
    r = await pg.query<{ ad_schedule: unknown }>(`select ad_schedule from campaigns where id = $1`, [id]);
    expect(r.rows[0]!.ad_schedule).toBeNull();
    expect(holder.calls).toHaveLength(0);
  });

  it("live: replaces the AdSchedule criteria at Google and leaves the audience alone", async () => {
    const id = await campaign({ launched: true, filters: { ages: ["25-34"] } });
    holder.searchRows.adGroup = [
      { adGroupCriterion: { resourceName: "agc-aud", type: "AUDIENCE", audience: { audience: "customers/1234567890/audiences/88" } } },
    ];
    holder.searchRows.campaignCriteria = [
      { campaignCriterion: { resourceName: "cc-sun", type: "AD_SCHEDULE", adSchedule: { dayOfWeek: "SUNDAY", startHour: 9, startMinute: "ZERO", endHour: 17, endMinute: "ZERO" } } },
    ];
    const res = await put(id, { adSchedule: monFri });
    expect(res.statusCode).toBe(200);
    expect(mutates()[0]!.body.mutateOperations).toEqual([
      { campaignCriterionOperation: { remove: "cc-sun" } },
      ...["MONDAY", "FRIDAY"].map((dayOfWeek) => ({
        campaignCriterionOperation: {
          create: {
            campaign: "customers/1234567890/campaigns/5",
            adSchedule: { dayOfWeek, startHour: 9, startMinute: "ZERO", endHour: 17, endMinute: "ZERO" },
          },
        },
      })),
    ]);
    const r = await pg.query<{ ad_schedule: unknown; audience_filters: unknown; google_audience_resource_name: string }>(
      `select ad_schedule, audience_filters, google_audience_resource_name from campaigns where id = $1`,
      [id],
    );
    expect(r.rows[0]).toEqual({
      ad_schedule: { days: ["mon", "fri"], startHour: 9, endHour: 17 },
      audience_filters: { ages: ["25-34"] },
      google_audience_resource_name: "customers/1234567890/audiences/88",
    });
  });

  it("$55 a month: an owner's schedule is 'custom'; scheduleMode spread hands the days back to AdVault", async () => {
    const id = await campaign({ launched: false });
    const mode = async () =>
      (await pg.query<{ schedule_mode: string; ad_schedule: unknown }>(`select schedule_mode, ad_schedule from campaigns where id = $1`, [id])).rows[0]!;
    expect((await mode()).schedule_mode).toBe("spread");
    await put(id, { adSchedule: monFri });
    expect((await mode()).schedule_mode).toBe("custom");
    expect((await put(id, { scheduleMode: "spread" })).statusCode).toBe(200);
    // Before launch: launch picks the days from the budget then.
    expect(await mode()).toEqual({ schedule_mode: "spread", ad_schedule: null });
    expect((await put(id, { scheduleMode: "spread", adSchedule: monFri })).statusCode).toBe(400);
  });

  it("refuses an empty body and a backwards window", async () => {
    const id = await campaign({ launched: false });
    expect((await put(id, {})).statusCode).toBe(400);
    expect((await put(id, { adSchedule: { days: ["mon"], startHour: 17, endHour: 9 } })).statusCode).toBe(400);
  });
});

describe("PATCH /campaigns/:id after launch", () => {
  it("refuses adSchedule on a launched campaign", async () => {
    const id = await campaign({ launched: true, status: "paused" });
    const res = await app.inject({
      method: "PATCH",
      url: `/campaigns/${id}`,
      headers: { "x-test-user": userId },
      payload: { adSchedule: { days: ["mon"], startHour: 9, endHour: 17 } },
    });
    expect(res.statusCode).toBe(409);
  });

  it("refuses audienceFilters on a paused, launched campaign (use the targeting route)", async () => {
    const id = await campaign({ launched: true, status: "paused" });
    const res = await app.inject({
      method: "PATCH",
      url: `/campaigns/${id}`,
      headers: { "x-test-user": userId },
      payload: { audienceFilters: { ages: ["35-44"] } },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("campaign_already_launched");
  });
});

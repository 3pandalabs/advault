// The daily-budget floor (2026-11-19). Google refuses a USD Demand Gen budget
// under $5/day (BUDGET_BELOW_PER_DAY_MINIMUM); AdVault had lowered its floor to
// $1, so $1-$4.99 campaigns paid and then failed at launch with Google's raw
// error. Covers the create schema, PATCH, the launch pre-check (dry run and
// real) and the mapping of Google's own error, through Fastify on PGlite.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "../db/schema.js";
import { GoogleAdsApiError } from "../lib/googleAds/client.js";
import { budgetBelowMinimum, minDailyBudgetMinorFor } from "../lib/pricing/index.js";

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
  return { db: null as unknown, launchDemandGen: vi.fn() };
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

vi.mock("../lib/googleAds/env.js", async (orig) => ({
  ...(await orig<typeof import("../lib/googleAds/env.js")>()),
  isGoogleAdsConfigured: () => true,
}));

vi.mock("../lib/googleAds/demandGen.js", async (orig) => ({
  ...(await orig<typeof import("../lib/googleAds/demandGen.js")>()),
  launchDemandGen: holder.launchDemandGen,
}));

let app: FastifyInstance;
let pg: PGlite;
let userId: string;

const base = {
  name: "Spring offer",
  businessName: "Joe's Plumbing",
  businessCategory: "Plumbing",
  targetZipCodes: ["10001"],
};

async function campaignWithBudget(cents: number, currency = "USD"): Promise<string> {
  const r = await pg.query<{ id: string }>(
    `insert into campaigns (user_id, name, business_name, business_category, target_zip_codes, daily_budget_cents, currency_code, landing_url)
     values ($1, 'c', 'b', 'Plumbing', '{10001}', $2, $3, 'https://example.com') returning id`,
    [userId, cents, currency],
  );
  return r.rows[0]!.id;
}

const call = (method: "POST" | "PATCH", url: string, payload: object) =>
  app.inject({ method, url, headers: { "x-test-user": userId }, payload });

beforeAll(async () => {
  pg = new PGlite();
  const dir = join(__dirname, "../../drizzle");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    await pg.exec(readFileSync(join(dir, f), "utf8").replaceAll("--> statement-breakpoint", ""));
  }
  holder.db = drizzle(pg, { schema });
  const r = await pg.query<{ id: string }>(
    `insert into users (email, password_hash, role) values ('shop@x.test', 'x', 'advertiser') returning id`,
  );
  userId = r.rows[0]!.id;

  const { campaignRoutes } = await import("./campaigns.js");
  const { launchRoutes } = await import("./launch.js");
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(campaignRoutes);
  await app.register(launchRoutes);
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
});

describe("the floor itself", () => {
  it("is $5/day for USD and ₹100/day for INR", () => {
    expect(minDailyBudgetMinorFor("USD")).toBe(500);
    expect(minDailyBudgetMinorFor("INR")).toBe(10_000);
    expect(budgetBelowMinimum(500, "USD")).toBeNull();
    expect(budgetBelowMinimum(499, "USD")).toMatchObject({
      error: "budget_below_minimum",
      minDailyBudgetMinor: 500,
      detail: "Google needs at least $5 a day for this kind of ad. Raise your daily budget to launch.",
    });
  });
});

describe("create schema", () => {
  it("rejects 499 and accepts 500 for USD", async () => {
    const { campaignInput } = await import("./campaigns.js");
    const low = campaignInput.safeParse({ ...base, dailyBudgetCents: 499, currencyCode: "USD" });
    expect(low.success).toBe(false);
    expect(low.error!.issues[0]!.path).toEqual(["dailyBudgetCents"]);
    expect(campaignInput.safeParse({ ...base, dailyBudgetCents: 500, currencyCode: "USD" }).success).toBe(true);
    // Currency defaults to USD, so the floor applies without it too.
    expect(campaignInput.safeParse({ ...base, dailyBudgetCents: 100 }).success).toBe(false);
  });

  it("keeps INR on its own ₹100 floor", async () => {
    const { campaignInput } = await import("./campaigns.js");
    const pin = { ...base, targetZipCodes: ["560001"], currencyCode: "INR" };
    expect(campaignInput.safeParse({ ...pin, dailyBudgetCents: 9_999 }).success).toBe(false);
    expect(campaignInput.safeParse({ ...pin, dailyBudgetCents: 10_000 }).success).toBe(true);
  });

  it("POST /campaigns refuses $4.99 and creates $5", async () => {
    expect((await call("POST", "/campaigns", { ...base, dailyBudgetCents: 499 })).statusCode).toBe(400);
    expect((await call("POST", "/campaigns", { ...base, dailyBudgetCents: 500 })).statusCode).toBe(201);
  });
});

describe("PATCH /campaigns/:id", () => {
  it("refuses lowering the budget under the floor and allows raising an old $1 one", async () => {
    const id = await campaignWithBudget(100);
    const low = await call("PATCH", `/campaigns/${id}`, { dailyBudgetCents: 499 });
    expect(low.statusCode).toBe(400);
    expect(low.json()).toMatchObject({ error: "budget_below_minimum", minDailyBudgetMinor: 500 });
    // Editing something else on an old $1 campaign still works.
    expect((await call("PATCH", `/campaigns/${id}`, { name: "Renamed" })).statusCode).toBe(200);
    const ok = await call("PATCH", `/campaigns/${id}`, { dailyBudgetCents: 500 });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().dailyBudgetCents).toBe(500);
  });
});

describe("run length (runDays, migration 0033)", () => {
  it("the create schema accepts 7, 14, null or absent, nothing else", async () => {
    const { campaignInput } = await import("./campaigns.js");
    const ok = { ...base, dailyBudgetCents: 500 };
    for (const runDays of [7, 14, null, undefined]) {
      expect(campaignInput.safeParse({ ...ok, runDays }).success).toBe(true);
    }
    for (const runDays of [0, 1, 30, 21, "7", 7.5]) {
      expect(campaignInput.safeParse({ ...ok, runDays }).success).toBe(false);
    }
  });

  it("POST stores it (absent = always on) and PATCH changes it before launch only", async () => {
    const week = await call("POST", "/campaigns", { ...base, dailyBudgetCents: 500, runDays: 7 });
    expect(week.statusCode).toBe(201);
    expect(week.json().runDays).toBe(7);
    const always = await call("POST", "/campaigns", { ...base, dailyBudgetCents: 500 });
    expect(always.json().runDays).toBeNull();

    const id = week.json().id as string;
    const two = await call("PATCH", `/campaigns/${id}`, { runDays: 14 });
    expect(two.statusCode).toBe(200);
    expect(two.json().runDays).toBe(14);
    expect((await call("PATCH", `/campaigns/${id}`, { runDays: null })).json().runDays).toBeNull();
    expect((await call("PATCH", `/campaigns/${id}`, { runDays: 30 })).statusCode).toBe(400);

    // Once it exists at Google (here: launched, then paused) the end date is fixed.
    await pg.query(
      `update campaigns set status = 'paused', google_campaign_resource_name = 'customers/1/campaigns/2' where id = $1`,
      [id],
    );
    const late = await call("PATCH", `/campaigns/${id}`, { runDays: 7 });
    expect(late.statusCode).toBe(409);
    expect(late.json()).toEqual({ error: "campaign_already_launched" });
  });

  it("the CHECK constraint refuses other values at the database too", async () => {
    const id = await campaignWithBudget(500);
    await expect(pg.query(`update campaigns set run_days = 30 where id = $1`, [id])).rejects.toThrow();
  });
});

describe("launch pre-check", () => {
  const adAccountId = "00000000-0000-4000-8000-000000000000";

  for (const validateOnly of [true, false]) {
    it(`answers 409 budget_below_minimum for a $1 campaign (validateOnly: ${validateOnly})`, async () => {
      const id = await campaignWithBudget(100);
      const res = await call("POST", `/campaigns/${id}/launch`, { adAccountId, validateOnly });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({
        error: "budget_below_minimum",
        minDailyBudgetMinor: 500,
        currencyCode: "USD",
        detail: "Google needs at least $5 a day for this kind of ad. Raise your daily budget to launch.",
      });
      expect(holder.launchDemandGen).not.toHaveBeenCalled();
    });
  }

  it("lets a $5 campaign past the budget check", async () => {
    const id = await campaignWithBudget(500);
    const res = await call("POST", `/campaigns/${id}/launch`, { adAccountId, validateOnly: true });
    // Stops later, at the (missing) ad account, not at the budget.
    expect(res.json().error).not.toBe("budget_below_minimum");
  });
});

describe("Google's BUDGET_BELOW_PER_DAY_MINIMUM", () => {
  it("maps to the same plain message, with Google's minimum", async () => {
    const { googleBudgetMinimumError } = await import("./launch.js");
    // The shape the 2026-11-19 dry run returned.
    const err = new GoogleAdsApiError("Request contains an invalid argument.", 400, [
      {
        "@type": "type.googleapis.com/google.ads.googleads.v26.errors.GoogleAdsFailure",
        errors: [
          {
            errorCode: { campaignBudgetError: "BUDGET_BELOW_PER_DAY_MINIMUM" },
            message: "The budget is below the per-day minimum.",
            details: {
              budgetPerDayMinimumErrorDetails: {
                currencyCode: "USD",
                budgetPerDayMinimumMicros: "5000000",
                failedBudgetAmountMicros: "1000000",
              },
            },
          },
        ],
      },
    ]);
    expect(googleBudgetMinimumError(err, "USD")).toEqual({
      error: "budget_below_minimum",
      minDailyBudgetMinor: 500,
      currencyCode: "USD",
      detail: "Google needs at least $5 a day for this kind of ad. Raise your daily budget to launch.",
    });
  });

  it("ignores every other Google error", async () => {
    const { googleBudgetMinimumError } = await import("./launch.js");
    const other = new GoogleAdsApiError("x", 400, [{ errors: [{ errorCode: { fieldError: "REQUIRED" } }] }]);
    expect(googleBudgetMinimumError(other, "USD")).toBeNull();
    expect(googleBudgetMinimumError(new Error("boom"), "USD")).toBeNull();
  });
});

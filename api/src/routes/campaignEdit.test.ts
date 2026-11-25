// Editing and deleting a campaign before launch (2026-11-24): category
// changes, the housing crossing, and what a launched or paid campaign refuses.
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
let owner: string;
let stranger: string;
const ADDRESS = { street: "12 Maple Ave", city: "Edison", state: "NJ", postalCode: "08817" };

beforeAll(async () => {
  pg = new PGlite();
  const dir = join(__dirname, "../../drizzle");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    await pg.exec(readFileSync(join(dir, f), "utf8").replaceAll("--> statement-breakpoint", ""));
  }
  holder.db = drizzle(pg, { schema });
  const user = async (e: string) =>
    (await pg.query<{ id: string }>(`insert into users (email, password_hash) values ($1, 'x') returning id`, [e])).rows[0]!.id;
  owner = await user("owner@x.test");
  stranger = await user("other@x.test");
  const { campaignRoutes } = await import("./campaigns.js");
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(campaignRoutes);
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
});

const set = (id: string, k: string, v: unknown) => pg.query(`update campaigns set ${k} = $1 where id = $2`, [v, id]);

async function draft(category = "Other"): Promise<string> {
  const r = await pg.query<{ id: string }>(
    `insert into campaigns (user_id, name, business_name, business_category, target_zip_codes, daily_budget_cents, audience_filters, badges)
     values ($1, 'c', 'b', $2, '{10001}', 500, '{"ages":["25-34"]}', '{"ids":["x"]}') returning id`,
    [owner, category],
  );
  return r.rows[0]!.id;
}
async function launched(): Promise<string> {
  const id = await draft("Plumbing");
  await set(id, "status", "paused");
  await set(id, "google_campaign_resource_name", "customers/1/campaigns/2");
  return id;
}
const patch = (id: string, payload: object) =>
  app.inject({ method: "PATCH", url: `/campaigns/${id}`, headers: { "x-test-user": owner }, payload });
const del = (id: string, user = owner) =>
  app.inject({ method: "DELETE", url: `/campaigns/${id}`, headers: { "x-test-user": user } });
const row = async (id: string) =>
  (await pg.query<Record<string, unknown>>(`select * from campaigns where id = $1`, [id])).rows[0];
const creative = (id: string, kind: string) =>
  pg.query(
    `insert into creatives (campaign_id, aspect_ratio, kind) values ($1, '9:16', $2)`,
    [id, kind],
  );
const purchase = (id: string, sku: string, status: string) =>
  pg.query(
    `insert into purchases (user_id, campaign_id, add_on_key, sku, currency_code, amount_minor, provider, status)
     values ($1, $2, 'k', $3, 'USD', 1000, 'stripe', $4)`,
    [owner, id, sku, status],
  );

describe("changing the category", () => {
  it("to Real estate drops ZIPs, filters and old-category inputs, and needs an address", async () => {
    const id = await draft();
    const bad = await patch(id, { businessCategory: "Real estate" });
    expect([bad.statusCode, bad.json().error]).toEqual([400, "listing_address_required"]);
    expect(await row(id)).toMatchObject({ business_category: "Other", target_zip_codes: ["10001"] });
    // ZIPs and filters sent along can't survive the crossing either.
    const ok = await patch(id, {
      businessCategory: "Real estate",
      targetAddress: ADDRESS,
      targetZipCodes: ["10001"],
      audienceFilters: { ages: ["25-34"] },
      realty: { adType: "agent" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({
      businessCategory: "Real estate",
      targetZipCodes: [],
      audienceFilters: null,
      badges: null,
      targetAddress: ADDRESS,
      realty: { adType: "agent" },
    });
  });

  it("treats a housing word typed under Other the same way", async () => {
    const id = await draft();
    expect((await patch(id, { businessCategory: "Realtor" })).json().error).toBe("listing_address_required");
    expect((await patch(id, { businessCategory: "Realtor", targetAddress: ADDRESS })).json()).toMatchObject({
      targetZipCodes: [],
      audienceFilters: null,
    });
  });

  it("away from Real estate drops the address and listing, and needs ZIPs", async () => {
    const id = await draft();
    await patch(id, { businessCategory: "Real estate", targetAddress: ADDRESS, realty: { adType: "agent" } });
    expect((await patch(id, { businessCategory: "Plumbing" })).json().error).toBe("zip_codes_required");
    expect((await patch(id, { businessCategory: "Plumbing", targetZipCodes: ["08817"] })).json()).toMatchObject({
      targetZipCodes: ["08817"],
      targetAddress: null,
      realty: null,
    });
  });

  it("keeps the area within ordinary categories, and everything when nothing changes", async () => {
    const id = await draft("Plumbing");
    expect((await patch(id, { businessCategory: "Plumbing", name: "n" })).json().badges).toEqual({ ids: ["x"] });
    expect((await patch(id, { businessCategory: "HVAC" })).json()).toMatchObject({
      targetZipCodes: ["10001"],
      badges: null,
      audienceFilters: { ages: ["25-34"] },
    });
  });

  it("is locked once an ad was made or paid for, but not by the owner's own video", async () => {
    const own = await draft("Plumbing");
    await creative(own, "upload");
    expect((await patch(own, { businessCategory: "HVAC" })).statusCode).toBe(200);
    const made = await draft("Plumbing");
    await creative(made, "standard");
    expect((await patch(made, { businessCategory: "HVAC" })).json().error).toBe("category_locked");
    expect((await patch(made, { businessCategory: "Plumbing", targetZipCodes: ["08817"] })).statusCode).toBe(200);
    const paid = await draft("Plumbing");
    await purchase(paid, "new_ad", "pending");
    expect((await patch(paid, { businessCategory: "HVAC" })).statusCode).toBe(200);
    await purchase(paid, "new_ad", "paid");
    expect((await patch(paid, { businessCategory: "Cleaning" })).json().error).toBe("category_locked");
  });
});

describe("a launched campaign", () => {
  it("refuses category and area changes while paused; other edits still work", async () => {
    const id = await launched();
    for (const p of [
      { businessCategory: "HVAC" },
      { targetZipCodes: ["08817"] },
      { radiusMiles: 5 },
      { targetAddress: ADDRESS },
      { realty: { adType: "agent" } },
    ]) {
      const res = await patch(id, p);
      expect([res.statusCode, res.json().error]).toEqual([409, "campaign_already_launched"]);
    }
    expect((await patch(id, { landingUrl: "https://example.com" })).statusCode).toBe(200);
    expect((await patch(id, { name: "Renamed" })).statusCode).toBe(200);
  });
});

describe("deleting", () => {
  it("removes an unlaunched, unpaid draft and its own videos, for its owner only", async () => {
    const id = await draft();
    await creative(id, "upload");
    expect((await del(id, stranger)).statusCode).toBe(404);
    expect((await del(id)).statusCode).toBe(204);
    expect(await row(id)).toBeUndefined();
  });

  it("refuses launched, live, rendering and paid campaigns", async () => {
    expect((await del(await launched())).json().error).toBe("campaign_already_launched");
    const live = await draft();
    await set(live, "status", "live");
    expect((await del(live)).json().error).toBe("campaign_is_live");
    const rendering = await draft();
    await set(rendering, "status", "rendering");
    expect((await del(rendering)).json().error).toBe("campaign_rendering");
    const site = await draft();
    await purchase(site, "website", "paid");
    expect((await del(site)).json().error).toBe("campaign_has_payment");
    expect(await row(site)).toBeDefined();
  });
});

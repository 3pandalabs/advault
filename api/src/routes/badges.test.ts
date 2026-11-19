// Badges (0039) and offer claim checks through Fastify against PGlite (every
// drizzle/*.sql applied). Nothing here calls Google or a paid API.
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
    TOKEN_ENCRYPTION_KEY: "0".repeat(64),
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
  },
}));

const MIGRATIONS = join(__dirname, "../../drizzle");
let app: FastifyInstance;
let pg: PGlite;
let owner: string;
let stranger: string;

beforeAll(async () => {
  pg = new PGlite();
  for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith(".sql")).sort()) {
    await pg.exec(readFileSync(join(MIGRATIONS, f), "utf8").replaceAll("--> statement-breakpoint", ""));
  }
  holder.db = drizzle(pg, { schema });
  owner = (await pg.query<{ id: string }>(`insert into users (email, password_hash) values ('lawn@x.test', 'x') returning id`)).rows[0]!.id;
  stranger = (await pg.query<{ id: string }>(`insert into users (email, password_hash) values ('o@x.test', 'x') returning id`)).rows[0]!.id;
  const { badgeRoutes } = await import("./badges.js");
  const { campaignOfferRoutes } = await import("./campaignOffer.js");
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(badgeRoutes);
  await app.register(campaignOfferRoutes);
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
});

async function campaign(category: string): Promise<string> {
  const r = await pg.query<{ id: string }>(
    `insert into campaigns (user_id, name, business_name, business_category, target_zip_codes, daily_budget_cents)
     values ($1, 'Trust', 'Ace Plumbing', $2, '{08817}', 1000) returning id`,
    [owner, category],
  );
  return r.rows[0]!.id;
}

const req = (method: "GET" | "PUT", url: string, payload?: unknown, user = owner) =>
  app.inject({ method, url, headers: { "x-test-user": user }, ...(payload ? { payload: payload as object } : {}) });

describe("migration 0039_campaign_badges", () => {
  it("is idempotent", async () => {
    await pg.exec(readFileSync(join(MIGRATIONS, "0039_campaign_badges.sql"), "utf8"));
    const cols = await pg.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_name = 'campaigns' and column_name like 'badges%' order by 1`,
    );
    expect(cols.rows.map((r) => r.column_name)).toEqual(["badges", "badges_attested_at", "badges_attested_by"]);
  });
});

describe("GET/PUT /campaigns/:id/badges", () => {
  it("lists the category's options", async () => {
    const id = await campaign("Auto repair");
    const res = await req("GET", `/campaigns/${id}/badges`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ selection: { ids: [] }, chips: [], attestedAt: null });
    expect(res.json().options).toContain("ase_certified");
  });

  it("saves attested badges with the license number, and records who and when", async () => {
    const id = await campaign("Plumbing");
    const res = await req("PUT", `/campaigns/${id}/badges`, { ids: ["license_number", "licensed_insured"], licenseNumber: " PL-123 ", attested: true });
    expect(res.statusCode).toBe(200);
    expect(res.json().chips).toEqual(["LIC #PL-123", "Licensed & insured"]);
    const row = await pg.query<{ badges: unknown; badges_attested_by: string }>(`select badges, badges_attested_by from campaigns where id = $1`, [id]);
    expect(row.rows[0]).toEqual({ badges: { ids: ["license_number", "licensed_insured"], licenseNumber: "PL-123" }, badges_attested_by: owner });
  });

  it("refuses without the tick, a badge from another category, and another advertiser", async () => {
    const id = await campaign("Dentistry");
    expect((await req("PUT", `/campaigns/${id}/badges`, { ids: ["financing"] })).json().error).toBe("badge_attestation_required");
    expect((await req("PUT", `/campaigns/${id}/badges`, { ids: ["ase_certified"], attested: true })).json().error).toBe("badge_not_for_category");
    expect((await req("PUT", `/campaigns/${id}/badges`, { ids: ["nope"], attested: true })).statusCode).toBe(400);
    expect((await req("PUT", `/campaigns/${id}/badges`, { ids: [], attested: false }, stranger)).statusCode).toBe(404);
  });

  it("an empty list removes them", async () => {
    const id = await campaign("Plumbing");
    await req("PUT", `/campaigns/${id}/badges`, { ids: ["financing"], attested: true });
    const res = await req("PUT", `/campaigns/${id}/badges`, { ids: [] });
    expect(res.json()).toMatchObject({ chips: [], attestedAt: null });
  });
});

describe("claim checks on PUT /campaigns/:id/offer", () => {
  it("refuses a housing exclusion, with the reason", async () => {
    const id = await campaign("Real estate");
    const res = await req("PUT", `/campaigns/${id}/offer`, { offerDetails: "Bright condo. Adults only." });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "claim_not_allowed", phrase: "Adults only" });
  });

  it("saves a warned claim and returns the warnings", async () => {
    const id = await campaign("Dentistry");
    const res = await req("PUT", `/campaigns/${id}/offer`, { offerDetails: "Painless cleanings, evenings too." });
    expect(res.statusCode).toBe(200);
    expect(res.json().warnings.map((w: { id: string }) => w.id)).toEqual(["health_painless"]);
  });
});

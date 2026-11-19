// PUT /campaigns/:id/offer through Fastify against PGlite (every
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
  const { campaignOfferRoutes } = await import("./campaignOffer.js");
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(campaignOfferRoutes);
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
});

async function campaign(category: string, status = "draft", launched = false): Promise<string> {
  const r = await pg.query<{ id: string }>(
    `insert into campaigns (user_id, name, business_name, business_category, target_zip_codes, daily_budget_cents, status, google_campaign_resource_name, offer_details)
     values ($1, 'Fall', 'Green Lawns', $2, '{08817}', 1000, $3, $4, 'Weekly mowing from $35.') returning id`,
    [owner, category, status, launched ? "customers/1/campaigns/2" : null],
  );
  return r.rows[0]!.id;
}

const put = (id: string, payload: unknown, user = owner) =>
  app.inject({ method: "PUT", url: `/campaigns/${id}/offer`, headers: { "x-test-user": user }, payload: payload as object });

describe("PUT /campaigns/:id/offer", () => {
  it("saves the offer and call to action on a draft", async () => {
    const id = await campaign("Landscaping");
    const res = await put(id, { offerDetails: "  Fall leaf removal from $129.  ", callToAction: "Book a cleanup" });
    expect(res.statusCode).toBe(200);
    expect(res.json().campaign).toMatchObject({ offerDetails: "Fall leaf removal from $129.", callToAction: "Book a cleanup" });
    expect(res.json().liveAdUnchanged).toBe(false);
  });

  it("works on a live campaign and says the live ad is unchanged (no Google call)", async () => {
    const id = await campaign("Landscaping", "live", true);
    const res = await put(id, { offerDetails: "Snow removal plans." });
    expect(res.statusCode).toBe(200);
    expect(res.json().liveAdUnchanged).toBe(true);
    const row = await pg.query<{ status: string; call_to_action: string }>(`select status, call_to_action from campaigns where id = $1`, [id]);
    expect(row.rows[0]).toEqual({ status: "live", call_to_action: "Call now" });
  });

  it("refuses empty text and another advertiser's campaign", async () => {
    const id = await campaign("Landscaping");
    expect((await put(id, { offerDetails: "   " })).statusCode).toBe(400);
    expect((await put(id, { offerDetails: "x", extra: 1 })).statusCode).toBe(400);
    expect((await put(id, { offerDetails: "Mine now" }, stranger)).statusCode).toBe(404);
  });
});

// Category extras (0040) through Fastify against PGlite (every drizzle/*.sql
// applied). Nothing here calls Google or a paid API.
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
  owner = (await pg.query<{ id: string }>(`insert into users (email, password_hash) values ('pizza@x.test', 'x') returning id`)).rows[0]!.id;
  stranger = (await pg.query<{ id: string }>(`insert into users (email, password_hash) values ('o@x.test', 'x') returning id`)).rows[0]!.id;
  const { categoryExtrasRoutes } = await import("./categoryExtras.js");
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(categoryExtrasRoutes);
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
});

async function campaign(category: string): Promise<string> {
  const r = await pg.query<{ id: string }>(
    `insert into campaigns (user_id, name, business_name, business_category, target_zip_codes, daily_budget_cents)
     values ($1, 'Extras', 'Tony''s', $2, '{08817}', 1000) returning id`,
    [owner, category],
  );
  return r.rows[0]!.id;
}

async function photo(userId = owner): Promise<string> {
  const r = await pg.query<{ id: string }>(
    `insert into assets (user_id, kind, r2_key, content_type) values ($1, 'photo', $2, 'image/jpeg') returning id`,
    [userId, `users/${userId}/${Math.random().toString(36).slice(2)}.jpg`],
  );
  return r.rows[0]!.id;
}

const req = (method: "GET" | "PUT", url: string, payload?: unknown, user = owner) =>
  app.inject({ method, url, headers: { "x-test-user": user }, ...(payload ? { payload: payload as object } : {}) });

describe("migration 0040_campaign_category_extras", () => {
  it("is idempotent", async () => {
    await pg.exec(readFileSync(join(MIGRATIONS, "0040_campaign_category_extras.sql"), "utf8"));
    const cols = await pg.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_name = 'campaigns' and column_name = 'category_extras'`,
    );
    expect(cols.rows).toHaveLength(1);
  });
});

describe("GET/PUT /campaigns/:id/extras", () => {
  it("restaurant: saves the dish (own photo) and the order link, trimmed", async () => {
    const id = await campaign("Restaurant");
    const dish = await photo();
    expect((await req("GET", `/campaigns/${id}/extras`)).json()).toEqual({ available: ["spotlight", "orderUrl"], extras: {} });
    const res = await req("PUT", `/campaigns/${id}/extras`, {
      spotlight: { dish: " Margherita ", price: "$14", assetId: dish },
      orderUrl: " https://order.example.com/tonys ",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().extras).toEqual({
      spotlight: { dish: "Margherita", price: "$14", assetId: dish },
      orderUrl: "https://order.example.com/tonys",
    });
  });

  it("refuses another advertiser's photo, another category's extras, a bad link", async () => {
    const id = await campaign("Restaurant");
    const theirs = await photo(stranger);
    expect((await req("PUT", `/campaigns/${id}/extras`, { spotlight: { dish: "Pie", assetId: theirs } })).json().error).toBe("unknown_assets");
    expect((await req("PUT", `/campaigns/${id}/extras`, { makes: ["Ford"] })).json().error).toBe("extras_not_for_category");
    expect((await req("PUT", `/campaigns/${id}/extras`, { orderUrl: "javascript:x" })).json().error).toBe("order_url_invalid");
    expect((await req("GET", `/campaigns/${id}/extras`, undefined, stranger)).statusCode).toBe(404);
  });

  it("auto makes and landscaping ZIPs; empty clears", async () => {
    const auto = await campaign("Auto repair");
    expect((await req("PUT", `/campaigns/${auto}/extras`, { makes: ["Toyota", " Honda", "Toyota"] })).json().extras).toEqual({
      makes: ["Toyota", "Honda"],
    });
    const lawn = await campaign("Landscaping");
    expect((await req("PUT", `/campaigns/${lawn}/extras`, { neighborZips: ["08817", "08820"] })).json().extras).toEqual({
      neighborZips: ["08817", "08820"],
    });
    expect((await req("PUT", `/campaigns/${lawn}/extras`, { neighborZips: [] })).json().extras).toEqual({});
    const row = await pg.query<{ category_extras: unknown }>(`select category_extras from campaigns where id = $1`, [lawn]);
    expect(row.rows[0]!.category_extras).toBeNull();
  });
});

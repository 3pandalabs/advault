// "Show your work: before & after" through Fastify against PGlite (every
// drizzle/*.sql applied, 0029 re-run to prove it idempotent), R2 and
// SiteVault stubbed. Nothing here calls a paid API.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
    SITEVAULT_INTERNAL_TOKEN: "sv-token",
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
  // website.ts imports it (admin "Delete it and make a new one"); unused here.
  requireAdmin: async (_req: FastifyRequest, reply: FastifyReply) => reply.code(403).send({ error: "admin_role_required" }),
}));
// Every stored photo is a small JPEG; no polished (pro) copies exist.
vi.mock("../plugins/r2.js", () => ({
  headObject: async (key: string) => (key.includes("/pro/") ? null : { sizeBytes: 1000, contentType: "image/jpeg" }),
  getObjectBytes: async (key: string) => Buffer.from(`bytes:${key}`),
  presignDownload: async (key: string) => `https://r2.invalid/${key}`,
  putObject: async () => undefined,
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
  owner = (await pg.query<{ id: string }>(`insert into users (email, password_hash) values ('roof@x.test', 'x') returning id`)).rows[0]!.id;
  stranger = (await pg.query<{ id: string }>(`insert into users (email, password_hash) values ('other@x.test', 'x') returning id`)).rows[0]!.id;
  const { beforeAfterRoutes } = await import("./beforeAfter.js");
  const { websiteRoutes } = await import("./website.js");
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(beforeAfterRoutes);
  await app.register(websiteRoutes);
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
});
afterEach(() => vi.unstubAllGlobals());

async function campaign(category: string): Promise<string> {
  const r = await pg.query<{ id: string }>(
    `insert into campaigns (user_id, name, business_name, business_category, target_zip_codes, daily_budget_cents)
     values ($1, 'Spring', 'Top Roofing', $2, '{08817}', 1000) returning id`,
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

const put = (id: string, payload: unknown, user = owner) =>
  app.inject({ method: "PUT", url: `/campaigns/${id}/before-after`, headers: { "x-test-user": user }, payload: payload as object });

describe("migration 0029_before_after", () => {
  it("is idempotent (runs again on every container start)", async () => {
    await pg.exec(readFileSync(join(MIGRATIONS, "0029_before_after.sql"), "utf8"));
    const cols = await pg.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_name = 'campaigns' and column_name like 'before_after%' order by 1`,
    );
    expect(cols.rows.map((r) => r.column_name)).toEqual(["before_after", "before_after_attested_at", "before_after_attested_by"]);
  });
});

describe("PUT /campaigns/:id/before-after", () => {
  it("saves pairs with who attested and when, and GET returns them with keys", async () => {
    const id = await campaign("Roofing");
    const [b, a] = [await photo(), await photo()];
    const res = await put(id, { pairs: [{ beforeAssetId: b, afterAssetId: a }], attested: true });
    expect(res.statusCode).toBe(200);
    const row = (await pg.query<{ before_after: unknown; before_after_attested_at: Date | null; before_after_attested_by: string | null }>(
      `select before_after, before_after_attested_at, before_after_attested_by from campaigns where id = $1`,
      [id],
    )).rows[0]!;
    expect(row.before_after).toEqual([{ beforeAssetId: b, afterAssetId: a }]);
    expect(row.before_after_attested_at).toBeInstanceOf(Date);
    expect(row.before_after_attested_by).toBe(owner);

    const got = await app.inject({ method: "GET", url: `/campaigns/${id}/before-after`, headers: { "x-test-user": owner } });
    expect(got.json()).toMatchObject({ allowed: true, pairs: [{ beforeAssetId: b, afterAssetId: a, beforeKey: expect.stringContaining(".jpg") }] });
  });

  it("refuses without the attestation tick", async () => {
    const id = await campaign("Roofing");
    const res = await put(id, { pairs: [{ beforeAssetId: await photo(), afterAssetId: await photo() }] });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "before_after_attestation_required" });
  });

  it("refuses health and cosmetic categories", async () => {
    const id = await campaign("Med spa");
    const res = await put(id, { pairs: [{ beforeAssetId: await photo(), afterAssetId: await photo() }], attested: true });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "before_after_not_for_category" });
    const got = await app.inject({ method: "GET", url: `/campaigns/${id}/before-after`, headers: { "x-test-user": owner } });
    expect(got.json()).toMatchObject({ allowed: false, pairs: [] });
  });

  it("refuses another advertiser's photo", async () => {
    const id = await campaign("Roofing");
    const res = await put(id, { pairs: [{ beforeAssetId: await photo(), afterAssetId: await photo(stranger) }], attested: true });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "unknown_assets" });
  });

  it("refuses more than two pairs and someone else's campaign", async () => {
    const id = await campaign("Roofing");
    const pair = async () => ({ beforeAssetId: await photo(), afterAssetId: await photo() });
    expect((await put(id, { pairs: [await pair(), await pair(), await pair()], attested: true })).statusCode).toBe(400);
    expect((await put(id, { pairs: [] }, stranger)).statusCode).toBe(404);
  });

  it("an empty list removes them", async () => {
    const id = await campaign("Roofing");
    await put(id, { pairs: [{ beforeAssetId: await photo(), afterAssetId: await photo() }], attested: true });
    const res = await put(id, { pairs: [] });
    expect(res.statusCode).toBe(200);
    const row = (await pg.query(`select before_after, before_after_attested_at from campaigns where id = $1`, [id])).rows[0];
    expect(row).toEqual({ before_after: null, before_after_attested_at: null });
  });
});

describe("Make me a website sends the pairs to SiteVault", () => {
  it("as ba1Before / ba1After files, the original photos", async () => {
    const id = await campaign("Roofing");
    const [b, a] = [await photo(), await photo()];
    await put(id, { pairs: [{ beforeAssetId: b, afterAssetId: a }], attested: true });
    let sent: FormData | null = null;
    vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/internal/account-site")) return new Response("not found", { status: 404 });
      if (url.endsWith("/api/internal/sites")) {
        sent = init!.body as FormData;
        // Stop here: nothing stored, no checkout.
        return new Response(JSON.stringify({ ok: false, error: "account_has_site", siteUrl: "https://x.3pandasite.com/" }), { status: 409 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    const res = await app.inject({
      method: "POST",
      url: `/campaigns/${id}/website`,
      headers: { "x-test-user": owner },
      payload: { phone: "555-201-1234", city: "Edison", attest: true },
    });
    expect(res.statusCode).toBe(409);
    expect(sent).not.toBeNull();
    const form = sent as unknown as FormData;
    expect([...form.keys()].filter((k) => k.startsWith("ba"))).toEqual(["ba1Before", "ba1After"]);
    const keys = (await pg.query<{ id: string; r2_key: string }>(`select id, r2_key from assets where id in ($1, $2)`, [b, a])).rows;
    const keyOf = (x: string) => keys.find((k) => k.id === x)!.r2_key;
    expect(await (form.get("ba1Before") as File).text()).toBe(`bytes:${keyOf(b)}`);
    expect(await (form.get("ba1After") as File).text()).toBe(`bytes:${keyOf(a)}`);
  });

  it("sends none for a campaign without pairs", async () => {
    const id = await campaign("Roofing");
    let sent: FormData | null = null;
    vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/internal/account-site")) return new Response("not found", { status: 404 });
      sent = init!.body as FormData;
      return new Response(JSON.stringify({ ok: false, error: "account_has_site" }), { status: 409 });
    });
    await app.inject({
      method: "POST",
      url: `/campaigns/${id}/website`,
      headers: { "x-test-user": owner },
      payload: { phone: "555-201-1234", city: "Edison", attest: true },
    });
    expect([...(sent as unknown as FormData).keys()].some((k) => k.startsWith("ba"))).toBe(false);
  });
});

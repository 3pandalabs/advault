// "Your website" routes through Fastify against PGlite, SiteVault stubbed.
// QA 2026-11-16: a website the same 3PandaLabs account built ON SiteVault was
// invisible here, so the card offered "Make me a website" ($10), use-existing
// 404'd, and a make with another phone would have built a second site.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../db/schema.js";

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
}));

let app: FastifyInstance;
let pg: PGlite;
let userId: string;

const SITE = "https://lawn-pros.3pandasite.com/";

/** What the stubbed SiteVault answers. */
type Stub = {
  accountSite: () => Response;
  create: () => Response;
};
let stub: Stub;
let calls: string[];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const liveSite = () => json({ ok: true, slug: "lawn-pros", siteUrl: SITE, state: "live", source: "web", count: 1 });
// An older SiteVault Worker without the route answers its HTML 404 page.
const oldWorker = () => new Response("<!doctype html><title>Page not found</title>", { status: 404, headers: { "content-type": "text/html" } });

beforeAll(async () => {
  pg = new PGlite();
  const dir = join(__dirname, "../../drizzle");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    await pg.exec(readFileSync(join(dir, f), "utf8").replaceAll("--> statement-breakpoint", ""));
  }
  holder.db = drizzle(pg, { schema });
  const res = await pg.query<{ id: string }>(`insert into users (email, password_hash) values ('owner@x.test', 'x') returning id`);
  userId = res.rows[0]!.id;
  const { websiteRoutes } = await import("./website.js");
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(websiteRoutes);
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
});

beforeEach(() => {
  calls = [];
  stub = { accountSite: liveSite, create: () => json({ ok: false, error: "unexpected" }, 500) };
  vi.stubGlobal("fetch", async (input: string | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/api/internal/account-site")) return stub.accountSite();
    if (url.endsWith("/api/internal/sites")) return stub.create();
    if (url.includes("/api/internal/resolve")) return json({ ok: true, slug: "lawn-pros", siteUrl: SITE });
    throw new Error(`unexpected fetch ${url}`);
  });
});
afterEach(() => vi.unstubAllGlobals());

async function newCampaign(): Promise<string> {
  const r = await pg.query<{ id: string }>(
    `insert into campaigns (user_id, name, business_name, business_category, target_zip_codes, daily_budget_cents)
     values ($1, 'Spring', 'Lawn Pros', 'landscaping', '{08817}', 1000) returning id`,
    [userId],
  );
  return r.rows[0]!.id;
}

const req = (method: "GET" | "POST", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { "x-test-user": userId }, ...(payload ? { payload: payload as object } : {}) });

const makeBody = { phone: "555-201-1234", city: "Edison", attest: true };

describe("a website the account built on SiteVault", () => {
  it("GET offers it as accountSite (Use my website), with no $10 quote", async () => {
    const id = await newCampaign();
    const res = await req("GET", `/campaigns/${id}/website`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.accountSite).toEqual({ siteUrl: SITE, state: "live" });
    expect(body).not.toHaveProperty("websiteFee");
    expect(calls.some((c) => c.includes("advaultUserId=") && c.includes("email=owner%40x.test"))).toBe(true);
  });

  it("use-existing links it as the campaign's website, with SiteVault's sign-in edit link", async () => {
    const id = await newCampaign();
    const res = await req("POST", `/campaigns/${id}/website/use-existing`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ siteUrl: SITE });
    const row = await pg.query<{ landing_url: string; sitevault_edit_enc: string | null }>(
      `select landing_url, sitevault_edit_enc from campaigns where id = $1`,
      [id],
    );
    expect(row.rows[0]).toEqual({ landing_url: SITE, sitevault_edit_enc: null });
    const after = await req("GET", `/campaigns/${id}/website`);
    expect(after.json()).toMatchObject({ siteUrl: SITE, editUrl: "https://sitevault.3pandalabs.com/edit/lawn-pros" });
  });

  it("use-existing refuses a site that isn't published on SiteVault", async () => {
    stub.accountSite = () => json({ ok: true, slug: "lawn-pros", siteUrl: SITE, state: "unpublished", source: "web" });
    const id = await newCampaign();
    const res = await req("POST", `/campaigns/${id}/website/use-existing`);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "account_website_not_live", detail: SITE });
  });

  it("make-website refuses before calling SiteVault's create (no second site, no checkout)", async () => {
    const id = await newCampaign();
    const res = await req("POST", `/campaigns/${id}/website`, makeBody);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "website_exists_for_account", detail: SITE });
    expect(calls.some((c) => c.endsWith("/api/internal/sites"))).toBe(false);
  });
});

describe("degrades when SiteVault can't answer the lookup", () => {
  it("an older SiteVault Worker (HTML 404): the card offers Make me a website, as before", async () => {
    stub.accountSite = oldWorker;
    const id = await newCampaign();
    const res = await req("GET", `/campaigns/${id}/website`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).not.toHaveProperty("accountSite");
  });

  it("SiteVault down (fetch throws): same, no error", async () => {
    stub.accountSite = () => {
      throw new Error("ECONNREFUSED");
    };
    const id = await newCampaign();
    const res = await req("GET", `/campaigns/${id}/website`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).not.toHaveProperty("accountSite");
    expect((await req("POST", `/campaigns/${id}/website/use-existing`)).statusCode).toBe(404);
  });

  it("SiteVault's create answers 409 account_has_site: friendly 409, nothing stored, no $10 checkout", async () => {
    stub.accountSite = oldWorker;
    stub.create = () => json({ ok: false, error: "account_has_site", slug: "lawn-pros", siteUrl: SITE }, 409);
    const id = await newCampaign();
    const res = await req("POST", `/campaigns/${id}/website`, makeBody);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "website_exists_for_account", detail: SITE });
    const row = await pg.query<{ landing_url: string | null; sitevault_pending_url: string | null }>(
      `select landing_url, sitevault_pending_url from campaigns where id = $1`,
      [id],
    );
    expect(row.rows[0]).toEqual({ landing_url: null, sitevault_pending_url: null });
    const purchases = await pg.query(`select 1 from purchases where campaign_id = $1`, [id]);
    expect(purchases.rows).toHaveLength(0);
  });
});

// "Make me a website" with SiteVault's FULL builder (2026-11-19): the handoff
// endpoint (POST /campaigns/:id/website/builder) and the post-create check
// (POST /campaigns/:id/website/builder/created), through Fastify against
// PGlite with SiteVault stubbed. SiteVault's own tests cover its side
// (token, draft, embed page, create) end to end.
import { createHmac, timingSafeEqual } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
    req.userRole = req.headers["x-test-role"] === "admin" ? "admin" : "advertiser";
  },
  requireAdmin: async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.userRole !== "admin") reply.code(403).send({ error: "admin_role_required" });
  },
}));

const SECRET = process.env.SITEVAULT_INTERNAL_TOKEN!;
const SITE = "https://lawn-pros.3pandasite.com/";
const DRAFT = "draft_abcdefghijklmnop";
let app: FastifyInstance;
let pg: PGlite;

type Who = { id: string; role: "admin" | "advertiser" };
type DraftReply = { campaignId: string; awaitingPayment: boolean; result: { slug: string; siteUrl: string; editUrl: string; pending: boolean } | null };
let stub: { accountSite: () => Response; draft: (url: URL) => Response };
let calls: { url: string; body?: unknown }[];
const draftsFor = new Map<string, { uid: string; reply: DraftReply }>();

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const noSite = () => json({ ok: false, error: "no_site" }, 404);

beforeAll(async () => {
  pg = new PGlite();
  const dir = join(__dirname, "../../drizzle");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    await pg.exec(readFileSync(join(dir, f), "utf8").replaceAll("--> statement-breakpoint", ""));
  }
  holder.db = drizzle(pg, { schema });
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
  draftsFor.clear();
  stub = {
    accountSite: noSite,
    draft: () => json({ ok: true, draftId: DRAFT, expiresAt: new Date().toISOString() }, 201),
  };
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url: url.toString(), body: init?.body });
    if (url.pathname === "/api/internal/account-site") return stub.accountSite();
    if (url.pathname === "/api/internal/drafts" && init?.method === "POST") return stub.draft(url);
    const m = url.pathname.match(/^\/api\/internal\/drafts\/(.+)$/);
    if (m) {
      // SiteVault: 404 unless the draft is this AdVault user's.
      const d = draftsFor.get(m[1]!);
      return d && d.uid === url.searchParams.get("advaultUserId") ? json({ ok: true, ...d.reply }) : json({ ok: false, error: "no_draft" }, 404);
    }
    if (url.pathname === "/api/internal/resolve") return json({ ok: true, siteUrl: SITE });
    throw new Error(`unexpected fetch ${url}`);
  });
});
afterEach(() => vi.unstubAllGlobals());

let n = 0;
async function newUser(role: "admin" | "advertiser" = "advertiser", email?: string): Promise<Who> {
  n += 1;
  const r = await pg.query<{ id: string }>(`insert into users (email, password_hash, role, phone) values ($1, 'x', $2, '555-201-0000') returning id`, [
    email ?? `b${n}@x.test`,
    role,
  ]);
  return { id: r.rows[0]!.id, role };
}
async function campaignFor(who: Who, cols: { landing_url?: string; sitevault_edit_enc?: string } = {}) {
  const r = await pg.query<{ id: string }>(
    `insert into campaigns (user_id, name, business_name, business_category, target_zip_codes, daily_budget_cents, offer_details, landing_url, sitevault_edit_enc)
     values ($1, 'Spring', 'Lawn Pros', 'landscaping', '{08817}', 1000, 'Spring cleanup $149', $2, $3) returning id`,
    [who.id, cols.landing_url ?? null, cols.sitevault_edit_enc ?? null],
  );
  return r.rows[0]!.id;
}
const as = (who: Who | null, url: string, payload?: unknown) =>
  app.inject({ method: "POST", url, headers: who ? { "x-test-user": who.id, "x-test-role": who.role } : {}, ...(payload ? { payload: payload as object } : {}) });

function verifyCreateToken(builderUrl: string): Record<string, unknown> {
  const token = new URL(builderUrl).searchParams.get("token")!;
  const [payload, sig] = token.split(".") as [string, string];
  const want = createHmac("sha256", SECRET).update(`sv-embed-create-v1.${payload}`).digest();
  const got = Buffer.from(sig, "base64url");
  expect(got.length === want.length && timingSafeEqual(got, want)).toBe(true);
  // ...and it is NOT a valid edit token.
  const edit = createHmac("sha256", SECRET).update(`sv-embed-v1.${payload}`).digest();
  expect(timingSafeEqual(got, edit)).toBe(false);
  return JSON.parse(Buffer.from(payload, "base64url").toString()) as Record<string, unknown>;
}

describe("POST /campaigns/:id/website/builder", () => {
  it("needs a signed-in user who owns the campaign", async () => {
    const owner = await newUser();
    const id = await campaignFor(owner);
    expect((await as(null, `/campaigns/${id}/website/builder`)).statusCode).toBe(401);
    expect((await as(await newUser(), `/campaigns/${id}/website/builder`)).statusCode).toBe(404);
    expect(calls.some((c) => c.url.includes("/api/internal/drafts"))).toBe(false);
  });

  it("stores the pre-fill on SiteVault and returns a signed 60 s create link naming only the draft", async () => {
    const who = await newUser();
    const id = await campaignFor(who);
    const res = await as(who, `/campaigns/${id}/website/builder`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.json() as { builderUrl: string; draftId: string; websiteFee: string | null };
    expect(body.draftId).toBe(DRAFT);
    expect(body.websiteFee).toBe("$10");
    expect(body.builderUrl).toMatch(/^https:\/\/sitevault\.3pandalabs\.com\/embed\/new\?token=/);
    const h = verifyCreateToken(body.builderUrl);
    expect(h).toMatchObject({ v: 1, purpose: "create", uid: who.id, campaignId: id, draft: DRAFT, pay: true });
    expect((h.exp as number) - (h.iat as number)).toBeLessThanOrEqual(60);
    // The draft went server to server with the campaign's facts.
    const form = calls.find((c) => c.url.endsWith("/api/internal/drafts"))!.body as FormData;
    expect(form.get("campaignId")).toBe(id);
    expect(form.get("ownerAdvaultUserId")).toBe(who.id);
    expect(form.get("businessName")).toBe("Lawn Pros");
    expect(form.get("category")).toBe("landscaping");
    expect(form.get("phone")).toBe("555-201-0000");
    expect(form.get("offer")).toBe("Spring cleanup $149");
    expect(form.get("awaitingPayment")).toBe("1");
  });

  it("refuses when the account already has a website (Use my website covers it), without a draft", async () => {
    const who = await newUser();
    const id = await campaignFor(who);
    stub.accountSite = () => json({ ok: true, slug: "lawn-pros", siteUrl: SITE, state: "live", source: "web", count: 1 });
    const res = await as(who, `/campaigns/${id}/website/builder`);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "website_exists_for_account", detail: SITE });
    expect(calls.some((c) => c.url.endsWith("/api/internal/drafts"))).toBe(false);
  });

  it("refuses a campaign that already has a link; admins are free and exempt from one-per-account", async () => {
    const who = await newUser();
    const linked = await campaignFor(who, { landing_url: "https://mine.example.com" });
    expect((await as(who, `/campaigns/${linked}/website/builder`)).json()).toMatchObject({ error: "website_exists" });
    const admin = await newUser("admin");
    const id = await campaignFor(admin);
    stub.accountSite = () => json({ ok: true, slug: "lawn-pros", siteUrl: SITE, state: "live", source: "web", count: 1 });
    const res = await as(admin, `/campaigns/${id}/website/builder`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ websiteFee: null });
    expect(verifyCreateToken((res.json() as { builderUrl: string }).builderUrl)).toMatchObject({ pay: false });
    const form = calls.find((c) => c.url.endsWith("/api/internal/drafts"))!.body as FormData;
    expect(form.get("ownerAdmin")).toBe("1");
  });

  it("test customers (no real email) and an unreachable/older SiteVault get website_builder_unavailable (quick form)", async () => {
    const tc = await newUser("advertiser", `tc${n}@test.invalid`);
    expect((await as(tc, `/campaigns/${await campaignFor(tc)}/website/builder`)).json()).toMatchObject({ error: "website_builder_unavailable" });
    const who = await newUser();
    stub.draft = () => new Response("<!doctype html>not found", { status: 404 });
    const res = await as(who, `/campaigns/${await campaignFor(who)}/website/builder`);
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: "website_builder_unavailable" });
  });
});

describe("POST /campaigns/:id/website/builder/created", () => {
  const made = (over: Partial<NonNullable<DraftReply["result"]>> = {}) => ({
    slug: "lawn-pros-2",
    siteUrl: "https://lawn-pros-2.3pandasite.com/",
    editUrl: "https://sitevault.3pandalabs.com/edit/lawn-pros-2?k=k",
    pending: false,
    ...over,
  });
  const done = (who: Who, id: string, body: unknown = { draftId: DRAFT, slug: "lawn-pros-2" }) => as(who, `/campaigns/${id}/website/builder/created`, body);

  it("free path: verifies the draft server side, then sets the campaign's link and edit link", async () => {
    const admin = await newUser("admin");
    const id = await campaignFor(admin);
    draftsFor.set(DRAFT, { uid: admin.id, reply: { campaignId: id, awaitingPayment: false, result: made() } });
    const res = await done(admin, id);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ siteUrl: "https://lawn-pros-2.3pandasite.com/" });
    const row = await pg.query<{ landing_url: string; sitevault_edit_enc: string | null; sitevault_pending_url: string | null }>(
      `select landing_url, sitevault_edit_enc, sitevault_pending_url from campaigns where id = $1`,
      [id],
    );
    expect(row.rows[0]!.landing_url).toBe("https://lawn-pros-2.3pandasite.com/");
    expect(row.rows[0]!.sitevault_edit_enc).toBeTruthy();
    expect(row.rows[0]!.sitevault_pending_url).toBeNull();
    // A repeated message changes nothing.
    expect((await done(admin, id)).statusCode).toBe(200);
  });

  it("paid path: keeps it as the made-but-unpaid site (checkout opened, or retried from the card)", async () => {
    const who = await newUser();
    const id = await campaignFor(who);
    draftsFor.set(DRAFT, { uid: who.id, reply: { campaignId: id, awaitingPayment: true, result: made({ pending: true }) } });
    const res = await done(who, id);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ siteUrl: null, pendingSite: { siteUrl: "https://lawn-pros-2.3pandasite.com/", paid: false, display: "$10" } });
    const row = await pg.query<{ landing_url: string | null; sitevault_pending_url: string }>(`select landing_url, sitevault_pending_url from campaigns where id = $1`, [id]);
    expect(row.rows[0]).toEqual({ landing_url: null, sitevault_pending_url: "https://lawn-pros-2.3pandasite.com/" });
  });

  it("never trusts the message: another user's draft, another campaign, no result yet, or a different slug", async () => {
    const who = await newUser();
    const id = await campaignFor(who);
    const other = await newUser();
    // The draft is someone else's: SiteVault answers 404.
    draftsFor.set(DRAFT, { uid: other.id, reply: { campaignId: id, awaitingPayment: false, result: made() } });
    expect((await done(who, id)).statusCode).toBe(404);
    // Theirs, but made for another campaign.
    draftsFor.set(DRAFT, { uid: who.id, reply: { campaignId: await campaignFor(who), awaitingPayment: false, result: made() } });
    expect((await done(who, id)).statusCode).toBe(404);
    draftsFor.set(DRAFT, { uid: who.id, reply: { campaignId: id, awaitingPayment: false, result: null } });
    expect((await done(who, id)).json()).toMatchObject({ error: "website_not_created_yet" });
    draftsFor.set(DRAFT, { uid: who.id, reply: { campaignId: id, awaitingPayment: false, result: made() } });
    expect((await done(who, id, { draftId: DRAFT, slug: "someone-else" })).json()).toMatchObject({ error: "website_mismatch" });
    // Another user's campaign id: 404 before SiteVault is asked.
    expect((await done(other, id)).statusCode).toBe(404);
    const row = await pg.query(`select landing_url, sitevault_pending_url from campaigns where id = $1`, [id]);
    expect(row.rows[0]).toEqual({ landing_url: null, sitevault_pending_url: null });
  });
});

// Leads inbox (lib/leads) end to end through Fastify against PGlite with every
// migration applied: SiteVault's internal routes (bearer) and the owner's
// dashboard routes (session, mocked requireAuth), the signed Confirm / Decline
// link, owner resolution, overlap, idempotency, emails, account deletion.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../db/schema.js";
import type { Db } from "../lib/sharedAccount/index.js";
import { resetOwnerEmailLimits, signLeadLink } from "../lib/leads/policy.js";

vi.mock("../auth/plugin.js", () => ({
  requireAuth: async (req: FastifyRequest, reply: FastifyReply) => {
    const id = req.headers["x-test-user"];
    if (typeof id !== "string") return reply.code(401).send({ error: "unauthorized" });
    (req as FastifyRequest & { userId?: string }).userId = id;
  },
}));

const TOKEN = "test-internal-token";
const auth = { authorization: `Bearer ${TOKEN}` };
let app: FastifyInstance;
let pg: PGlite;
let owner: string;
let other: string;
let tester: string;
let campaignId: string;

type Sent = { to: string; from?: string; fromName?: string; replyTo?: string; subject: string; text: string };
let sent: Sent[] = [];

async function newUser(email: string, extra = ""): Promise<string> {
  const r = await pg.query<{ id: string }>(
    `insert into users (email, password_hash, business_name${extra ? ", test_owner_id" : ""}) values ($1, 'x', 'Joe Plumbing'${extra ? ", " + extra : ""}) returning id`,
    [email],
  );
  return r.rows[0]!.id;
}

beforeAll(async () => {
  process.env.SITEVAULT_INTERNAL_TOKEN = TOKEN;
  process.env.JWT_SECRET = "test-jwt-secret-test-jwt-secret-0000";
  pg = new PGlite();
  const dir = join(__dirname, "../../drizzle");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    await pg.exec(readFileSync(join(dir, f), "utf8").replaceAll("--> statement-breakpoint", ""));
  }
  // 0050 / 0051 are idempotent.
  for (const f of ["0050_leads.sql", "0051_google_place.sql"]) {
    await pg.exec(readFileSync(join(dir, f), "utf8").replaceAll("--> statement-breakpoint", ""));
  }
  owner = await newUser("owner@x.test");
  other = await newUser("other@x.test");
  tester = await newUser(`test+1@advault.invalid`, `'${owner}'`);
  const c = await pg.query<{ id: string }>(
    `insert into campaigns (user_id, name, business_name, business_category, target_zip_codes, daily_budget_cents, landing_url)
     values ($1, 'c', 'Joe Plumbing', 'Plumbing', '{10001}', 500, 'https://joes.3pandasite.com') returning id`,
    [owner],
  );
  campaignId = c.rows[0]!.id;

  const db = drizzle(pg, { schema }) as unknown as Db;
  const { sitevaultLeadRoutes } = await import("./sitevaultLeads.js");
  const { leadRoutes } = await import("./leads.js");
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(sitevaultLeadRoutes, { db });
  await app.register(leadRoutes, { db });
  await app.ready();
}, 60_000);

beforeEach(() => {
  sent = [];
  resetOwnerEmailLimits();
  vi.stubEnv("MAILER_URL", "https://mailer.test");
  vi.stubEnv("MAILER_TOKEN", "t");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).startsWith("https://mailer.test")) {
        const msgs = JSON.parse(String(init!.body)).messages as Sent[];
        sent.push(...msgs);
        return new Response(JSON.stringify({ delivered: msgs.length }));
      }
      if (String(url).includes("/review-link")) {
        return new Response(JSON.stringify({ reviewUrl: String(url).includes("/sites/joes/") ? "https://g.page/r/joes/review" : null }));
      }
      return new Response("{}", { status: 404 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await app?.close();
  delete process.env.SITEVAULT_INTERNAL_TOKEN;
});

const post = (url: string, payload: unknown, headers: Record<string, string> = auth) =>
  app.inject({ method: "POST", url, payload: payload as object, headers });
const get = (url: string, headers: Record<string, string> = auth) => app.inject({ method: "GET", url, headers });

let n = 0;
const lead = (extra: Record<string, unknown> = {}) => ({
  slug: "joes",
  kind: "quote",
  name: "Sam Customer",
  phone: "555-0100",
  email: "sam@cust.test",
  message: "Leaky tap",
  idempotencyKey: `joes:k-${++n}`,
  ...extra,
});
const booking = (start: string, extra: Record<string, unknown> = {}) =>
  lead({ kind: "booking", booking: { service: "Inspection", durationMin: 60, start, timezone: "America/New_York" }, ...extra });

describe("internal SiteVault lead routes", () => {
  it("refuse a missing or wrong bearer before validating anything", async () => {
    for (const [m, url] of [
      ["POST", "/internal/sitevault/leads"],
      ["GET", "/internal/sitevault/leads/busy?slug=joes"],
      ["GET", "/internal/sitevault/leads"],
      ["POST", "/internal/sitevault/leads/x/status"],
      ["POST", "/internal/sitevault/leads/x/review-request"],
    ] as const) {
      for (const h of [{}, { authorization: "Bearer nope" }] as Record<string, string>[]) {
        const res = m === "GET" ? await get(url, h) : await post(url, {}, h);
        expect([url, res.statusCode]).toEqual([url, 401]);
      }
    }
  });

  it("store a lead, email the owner with reply-to the customer, and replay the same id", async () => {
    const body = lead({ source: { utmSource: "youtube", utmCampaign: campaignId, referrerHost: "YouTube.com" } });
    const res = await post("/internal/sitevault/leads", body);
    expect(res.statusCode).toBe(201);
    const { leadId } = res.json() as { leadId: string };
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: "owner@x.test", from: "sitevault@3pandalabs.com", replyTo: "sam@cust.test" });
    expect(sent[0]!.subject).toBe("New quote request from Sam Customer");
    expect(sent[0]!.text).toContain("Your AdVault ad");

    const again = await post("/internal/sitevault/leads", body);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ leadId });
    expect(sent).toHaveLength(1);
    const row = await pg.query<{ user_id: string; campaign_id: string; source: unknown }>(
      `select user_id, campaign_id, source from leads where id = $1`,
      [leadId],
    );
    expect(row.rows[0]).toMatchObject({ user_id: owner, campaign_id: campaignId, source: { referrerHost: "youtube.com" } });
  });

  it("validate the body", async () => {
    expect((await post("/internal/sitevault/leads", lead({ kind: "booking" }))).statusCode).toBe(400);
    expect((await post("/internal/sitevault/leads", lead({ slug: "Not A Slug!" }))).statusCode).toBe(400);
    expect((await post("/internal/sitevault/leads", lead({ photoUrls: ["http://x.test/a.jpg"] }))).statusCode).toBe(400);
    expect(
      (await post("/internal/sitevault/leads", booking("2026-12-01T10:00:00-05:00", { booking: { service: "x", durationMin: 60, start: "2026-12-01T10:00:00-05:00", timezone: "Mars/Base" } })))
        .statusCode,
    ).toBe(400);
  });

  it("refuse an overlapping booking, allow back-to-back, and report busy slots", async () => {
    const first = await post("/internal/sitevault/leads", booking("2026-12-01T10:00:00-05:00"));
    expect(first.statusCode).toBe(201);
    expect(sent[0]!.text).toContain("/leads/action?t=");
    const st = await pg.query<{ status: string }>(`select status from leads where id = $1`, [(first.json() as { leadId: string }).leadId]);
    expect(st.rows[0]!.status).toBe("requested");
    const clash = await post("/internal/sitevault/leads", booking("2026-12-01T10:30:00-05:00"));
    expect(clash.statusCode).toBe(409);
    expect(clash.json()).toEqual({ error: "slot_taken" });
    expect((await post("/internal/sitevault/leads", booking("2026-12-01T11:00:00-05:00"))).statusCode).toBe(201);
    // Another site's calendar is its own.
    expect((await post("/internal/sitevault/leads", booking("2026-12-01T10:00:00-05:00", { slug: "elsewhere" }))).statusCode).toBe(201);

    const busy = await get("/internal/sitevault/leads/busy?slug=joes&from=2026-12-01T00:00:00Z&to=2026-12-02T00:00:00Z");
    expect(busy.json()).toEqual({
      busy: [
        { start: "2026-12-01T15:00:00.000Z", end: "2026-12-01T16:00:00.000Z" },
        { start: "2026-12-01T16:00:00.000Z", end: "2026-12-01T17:00:00.000Z" },
      ],
    });
  });

  it("free the slot when a booking is declined, and email the customer", async () => {
    const r = await post("/internal/sitevault/leads", booking("2026-12-02T09:00:00-05:00"));
    const { leadId } = r.json() as { leadId: string };
    sent = [];
    expect((await post(`/internal/sitevault/leads/${leadId}/status`, { status: "declined", email: "other@x.test" })).statusCode).toBe(404);
    expect((await post(`/internal/sitevault/leads/${leadId}/status`, { status: "declined" })).statusCode).toBe(400);
    expect((await post(`/internal/sitevault/leads/${leadId}/status`, { status: "declined", advaultUserId: owner })).statusCode).toBe(204);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: "sam@cust.test", replyTo: "owner@x.test", fromName: "Joe Plumbing via SiteVault" });
    expect(sent[0]!.text).toContain("https://joes.3pandasite.com");
    // Same status again: no second email.
    await post(`/internal/sitevault/leads/${leadId}/status`, { status: "declined", advaultUserId: owner });
    expect(sent).toHaveLength(1);
    expect((await post("/internal/sitevault/leads", booking("2026-12-02T09:00:00-05:00"))).statusCode).toBe(201);
  });

  it("resolve the owner by id, by email, by the stored site link, or store it unmatched", async () => {
    const byId = await post("/internal/sitevault/leads", lead({ slug: "unlinked-a", advaultUserId: other }));
    const byEmail = await post("/internal/sitevault/leads", lead({ slug: "unlinked-b", ownerEmail: "Other@X.test" }));
    const byLink = await post("/internal/sitevault/leads", lead({ slug: "joes" }));
    const nobody = await post("/internal/sitevault/leads", lead({ slug: "nobody-knows", ownerEmail: "new@owner.test" }));
    const users = await pg.query<{ id: string; user_id: string | null }>(
      `select id, user_id from leads where id = any($1::uuid[])`,
      [[byId, byEmail, byLink, nobody].map((r) => (r.json() as { leadId: string }).leadId)],
    );
    const by = Object.fromEntries(users.rows.map((r) => [r.id, r.user_id]));
    expect(by[(byId.json() as { leadId: string }).leadId]).toBe(other);
    expect(by[(byEmail.json() as { leadId: string }).leadId]).toBe(other);
    expect(by[(byLink.json() as { leadId: string }).leadId]).toBe(owner);
    expect(by[(nobody.json() as { leadId: string }).leadId]).toBeNull();
    // Unmatched: still emailed to the address SiteVault gave, and listed for it.
    expect(sent.map((m) => m.to)).toContain("new@owner.test");
    const list = await get("/internal/sitevault/leads?email=new@owner.test");
    expect((list.json() as { leads: unknown[] }).leads).toHaveLength(1);
  });

  it("never email a *.invalid owner or customer", async () => {
    await pg.query(`insert into campaigns (user_id, name, business_name, business_category, target_zip_codes, daily_budget_cents, landing_url)
      values ($1, 'c', 'Test', 'Plumbing', '{10001}', 500, 'https://testsite.3pandasite.com')`, [tester]);
    const r = await post("/internal/sitevault/leads", booking("2026-12-03T09:00:00-05:00", { slug: "testsite", email: "c@cust.invalid" }));
    expect(r.statusCode).toBe(201);
    expect(sent).toEqual([]);
    const { leadId } = r.json() as { leadId: string };
    await post(`/internal/sitevault/leads/${leadId}/status`, { status: "confirmed", advaultUserId: tester });
    expect(sent).toEqual([]);
  });

  it("list only the matching owner's leads, with the contract fields", async () => {
    const res = await get(`/internal/sitevault/leads?slug=joes&advaultUserId=${owner}`);
    const { leads } = res.json() as { leads: Record<string, unknown>[] };
    expect(leads.length).toBeGreaterThan(0);
    for (const k of ["id", "kind", "status", "name", "phone", "email", "message", "bestTime", "photoUrls", "booking", "source", "createdAt"]) {
      expect(leads[0]).toHaveProperty(k);
    }
    const theirs = await get(`/internal/sitevault/leads?slug=joes&advaultUserId=${other}`);
    expect((theirs.json() as { leads: unknown[] }).leads).toEqual([]);
    expect((await get("/internal/sitevault/leads?slug=joes")).statusCode).toBe(400);
  });

  it("send one review request per lead: 400 without a customer email, 409 the second time", async () => {
    const withEmail = (await post("/internal/sitevault/leads", lead())).json() as { leadId: string };
    const noEmail = (await post("/internal/sitevault/leads", lead({ email: "" }))).json() as { leadId: string };
    sent = [];
    const body = { reviewUrl: "https://g.page/r/joes/review", advaultUserId: owner };
    expect((await post(`/internal/sitevault/leads/${noEmail.leadId}/review-request`, body)).statusCode).toBe(400);
    expect((await post(`/internal/sitevault/leads/${withEmail.leadId}/review-request`, { ...body, reviewUrl: "http://x.test" })).statusCode).toBe(400);
    expect((await post(`/internal/sitevault/leads/${withEmail.leadId}/review-request`, body)).statusCode).toBe(204);
    expect((await post(`/internal/sitevault/leads/${withEmail.leadId}/review-request`, body)).statusCode).toBe(409);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: "sam@cust.test", subject: "How did Joe Plumbing do?" });
    expect(sent[0]!.text).toContain("https://g.page/r/joes/review");
  });
});

describe("owner dashboard routes and the email link", () => {
  const me = { "x-test-user": "" };
  beforeEach(() => {
    me["x-test-user"] = owner;
  });

  it("list, count, filter and change status for the signed-in owner only", async () => {
    expect((await get("/leads", {})).statusCode).toBe(401);
    const list = (await get("/leads?kind=quote", me)).json() as { leads: { id: string; kind: string }[]; newCount: number };
    expect(list.leads.every((l) => l.kind === "quote")).toBe(true);
    expect(list.newCount).toBeGreaterThan(0);
    const id = list.leads[0]!.id;
    const changed = await post(`/leads/${id}/status`, { status: "contacted" }, me);
    expect(changed.statusCode).toBe(200);
    expect((await post(`/leads/${id}/status`, { status: "contacted" }, { "x-test-user": other })).statusCode).toBe(404);
    const count = (await get("/leads/count", me)).json() as { new: number };
    expect(count.new).toBe(list.newCount - 1);
  });

  it("ask for a review with SiteVault's link, and refuse when the site has none", async () => {
    const lid = ((await post("/internal/sitevault/leads", lead())).json() as { leadId: string }).leadId;
    expect((await get("/leads/review-links", me)).json()).toMatchObject({ links: { joes: "https://g.page/r/joes/review" } });
    sent = [];
    expect((await post(`/leads/${lid}/review-request`, undefined, me)).statusCode).toBe(204);
    expect(sent).toHaveLength(1);
    const elsewhere = ((await post("/internal/sitevault/leads", lead({ slug: "unlinked-a", advaultUserId: other }))).json() as { leadId: string })
      .leadId;
    expect((await post(`/leads/${elsewhere}/review-request`, undefined, { "x-test-user": other })).statusCode).toBe(409);
  });

  it("confirm a booking from the signed link in two steps; refuse a forged one", async () => {
    const lid = ((await post("/internal/sitevault/leads", booking("2026-12-05T14:00:00-05:00"))).json() as { leadId: string }).leadId;
    const token = signLeadLink(lid, "confirm")!;
    const preview = await post("/leads/link", { token }, {});
    expect(preview.json()).toMatchObject({ action: "confirm", status: "requested", name: "Sam Customer", service: "Inspection" });
    expect((preview.json() as { when: string }).when).toContain("2:00");
    sent = [];
    expect((await post("/leads/link/apply", { token }, {})).json()).toEqual({ status: "confirmed" });
    expect(sent.map((m) => m.subject)).toEqual(["Your booking with Joe Plumbing is confirmed"]);
    expect((await post("/leads/link/apply", { token }, {})).json()).toEqual({ status: "confirmed" });
    expect(sent).toHaveLength(1);
    expect((await post("/leads/link", { token: token.slice(0, -2) + "xx" }, {})).statusCode).toBe(400);
    expect((await post("/leads/link", { token: signLeadLink(lid, "decline", Date.now() - 30 * 86_400_000)! }, {})).statusCode).toBe(400);
  });

  it("a removed account takes its leads with it (FK cascade; lib/accountDeletion deletes them explicitly)", async () => {
    const victim = await newUser("gone@x.test");
    await post("/internal/sitevault/leads", lead({ slug: "gone-site", advaultUserId: victim }));
    await pg.query(`delete from users where id = $1`, [victim]);
    const left = await pg.query(`select 1 from leads where site_slug = 'gone-site'`);
    expect(left.rows).toHaveLength(0);
  });
});

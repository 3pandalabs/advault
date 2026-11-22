// WhatsApp phone + opt-in + OFFER_SWAP_WHATSAPP modes (2026-11-21, migration
// 0048) on PGlite with every drizzle/*.sql applied. The switches are REAL
// (credentials + WHATSAPP_SENDS=on in env); only Meta's HTTP is stubbed, so
// "nothing was sent" means no request left the process.
import { createHmac } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../../db/schema.js";

const holder = vi.hoisted(() => {
  const env: Record<string, string> = {
    DATABASE_URL: "postgres://unused@localhost/unused",
    JWT_SECRET: "test-jwt-secret-test-jwt-secret-0000",
    TOKEN_ENCRYPTION_KEY: "0".repeat(64),
    R2_ACCOUNT_ID: "x",
    R2_ACCESS_KEY_ID: "x",
    R2_SECRET_ACCESS_KEY: "x",
    R2_BUCKET: "x",
    R2_ENDPOINT: "https://r2.invalid",
  };
  for (const [k, v] of Object.entries(env)) process.env[k] ??= v;
  // Real switches: configured AND sends on. The mode is set per test.
  process.env.WHATSAPP_TOKEN = "test-token";
  process.env.WHATSAPP_PHONE_NUMBER_ID = "1484639768064802";
  process.env.WHATSAPP_APP_SECRET = "test-app-secret";
  process.env.WHATSAPP_SENDS = "on";
  delete process.env.WHATSAPP_PUBLIC_NUMBER;
  return { db: null as unknown, sent: [] as { to: string; type: string; body: unknown }[] };
});

vi.mock("../../db/index.js", () => ({
  get db() {
    return holder.db;
  },
}));
vi.mock("../../auth/plugin.js", () => ({
  requireAuth: async (req: FastifyRequest, reply: FastifyReply) => {
    const id = req.headers["x-test-user"];
    if (typeof id !== "string") return reply.code(401).send({ error: "unauthorized" });
    (req as FastifyRequest & { userId?: string }).userId = id;
  },
}));

let pg: PGlite;
let app: FastifyInstance;

beforeAll(async () => {
  pg = new PGlite();
  const dir = join(__dirname, "../../../drizzle");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    await pg.exec(readFileSync(join(dir, f), "utf8").replaceAll("--> statement-breakpoint", ""));
  }
  // 0048 again: idempotent.
  await pg.exec(readFileSync(join(dir, "0048_whatsapp_opt_in.sql"), "utf8").replaceAll("--> statement-breakpoint", ""));
  holder.db = drizzle(pg, { schema });

  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.startsWith("https://graph.facebook.com/")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { to: string; type: string };
      holder.sent.push({ to: body.to, type: body.type, body });
      return new Response(JSON.stringify({ messages: [{ id: `wamid.out.${holder.sent.length}.${Math.random()}` }] }), { status: 200 });
    }
    return realFetch(input, init);
  });

  const { authRoutes } = await import("../../routes/auth.js");
  const { offerRoutes } = await import("../../routes/offers.js");
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body: string, done) => {
    if ((req.routeOptions?.config as { rawBody?: boolean } | undefined)?.rawBody) {
      (req as unknown as { rawBody: string }).rawBody = body;
    }
    try {
      done(null, body.length ? JSON.parse(body) : undefined);
    } catch (err) {
      done(err as Error, undefined);
    }
  });
  await app.register(authRoutes);
  await app.register(offerRoutes);
  await app.ready();
}, 90_000);

afterAll(async () => {
  await app?.close();
});

beforeEach(() => {
  holder.sent.length = 0;
  process.env.OFFER_SWAP_WHATSAPP = "internal";
});

let n = 0;
async function user(opts: { phone?: string | null; optIn?: boolean; internal?: boolean; evergreen?: boolean; name?: string } = {}) {
  const id = (
    await pg.query<{ id: string }>(
      `insert into users (email, password_hash, display_name, business_name, phone, whatsapp_opt_in_at, is_internal)
       values ($1, 'x', $2, 'Sparkle Cleaning', $3, $4, $5) returning id`,
      [`u${++n}-${Math.random().toString(36).slice(2)}@x.test`, opts.name ?? "Maya", opts.phone ?? null, opts.optIn ? new Date() : null, opts.internal ?? false],
    )
  ).rows[0]!.id;
  if (opts.evergreen) {
    await pg.query(
      `insert into subscriptions (user_id, plan_key, line, currency_code, amount_minor, provider, status) values ($1, 'us-evergreen', 'evergreen', 'USD', 2000, 'stripe', 'active')`,
      [id],
    );
  }
  return id;
}

async function cycleFor(userId: string, status = "pending", promptedAt: Date | null = null) {
  return (
    await pg.query<{ id: string }>(
      `insert into offer_cycles (user_id, period_month, status, prompted_at) values ($1, date_trunc('month', now()) - ($2 || ' months')::interval, $3, $4) returning id`,
      [userId, String(n), status, promptedAt],
    )
  ).rows[0]!.id;
}

const sign = (raw: string) => `sha256=${createHmac("sha256", "test-app-secret").update(raw).digest("hex")}`;
let ref = 0;
function inbound(from: string, text: string) {
  const raw = JSON.stringify({
    entry: [{ changes: [{ value: { messages: [{ id: `wamid.in.${++ref}`, from, timestamp: "1", type: "text", text: { body: text } }] } }] }],
  });
  return app.inject({
    method: "POST",
    url: "/webhooks/whatsapp",
    payload: raw,
    headers: { "content-type": "application/json", "x-hub-signature-256": sign(raw) },
  });
}

describe("OFFER_SWAP_WHATSAPP modes and opt-in (monthly prompt)", () => {
  it("internal: only an internal, opted-in account is messaged", async () => {
    const { sendPrompt } = await import("./index.js");
    const customer = await user({ phone: "+15550001001", optIn: true });
    const internalNoOptIn = await user({ phone: "+15550001002", internal: true });
    const internal = await user({ phone: "+15550001003", optIn: true, internal: true, name: "Anil" });

    expect(await sendPrompt(await cycleFor(customer))).toMatchObject({ sent: false, reason: "no_phone" });
    expect(await sendPrompt(await cycleFor(internalNoOptIn))).toMatchObject({ sent: false, reason: "no_phone" });
    expect(holder.sent).toHaveLength(0);

    expect(await sendPrompt(await cycleFor(internal))).toEqual({ sent: true });
    expect(holder.sent).toHaveLength(1);
    const t = holder.sent[0]!.body as { to: string; template: { name: string; components: { parameters: { text: string }[] }[] } };
    expect(t.to).toBe("+15550001003");
    expect(t.template.name).toBe("advault_offer_prompt");
    // {{1}} name, {{2}} business, {{3}} running-since date
    const params = t.template.components[0]!.parameters.map((p) => p.text);
    expect(params).toHaveLength(3);
    expect(params.slice(0, 2)).toEqual(["Anil", "Sparkle Cleaning"]);
    expect(params[2]).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
  });

  it("the reminder carries three params too ({{3}} = reply-by date)", async () => {
    const { sendReminder } = await import("./index.js");
    const internal = await user({ phone: "+15550001004", optIn: true, internal: true });
    const promptedAt = new Date("2026-12-01T10:00:00Z");
    expect(await sendReminder(await cycleFor(internal, "prompted", promptedAt), 1)).toEqual({ sent: true });
    const t = holder.sent[0]!.body as { template: { name: string; components: { parameters: { text: string }[] }[] } };
    expect(t.template.name).toBe("advault_offer_reminder");
    expect(t.template.components[0]!.parameters.map((p) => p.text)).toEqual(["Maya", "Sparkle Cleaning", "Dec 13"]);
  });

  it("on: every opted-in account; never one without the opt-in", async () => {
    process.env.OFFER_SWAP_WHATSAPP = "on";
    const { sendPrompt } = await import("./index.js");
    const customer = await user({ phone: "+15550001005", optIn: true });
    const noOptIn = await user({ phone: "+15550001006" });
    expect(await sendPrompt(await cycleFor(customer))).toEqual({ sent: true });
    expect(await sendPrompt(await cycleFor(noOptIn))).toMatchObject({ sent: false });
    expect(holder.sent.map((s) => s.to)).toEqual(["+15550001005"]);
  });

  it("off: the offer-change loop is off for everyone", async () => {
    process.env.OFFER_SWAP_WHATSAPP = "off";
    const { offerSwapAllowedFor, whatsAppUser } = await import("./index.js");
    const internal = await user({ phone: "+15550001007", optIn: true, internal: true });
    expect(offerSwapAllowedFor(await whatsAppUser(internal))).toBe(false);
    const { handleSwapInbound } = await import("../offerSwap/whatsapp.js");
    expect(await handleSwapInbound({ providerRef: "x-off", from: "15550001007", body: "$5 off", timestamp: new Date(), kind: "text" })).toEqual({
      handled: false,
    });
    expect(holder.sent).toHaveLength(0);
  });

  it("internal: a non-internal Keep it running owner's WhatsApp is not handled", async () => {
    const { handleSwapInbound } = await import("../offerSwap/whatsapp.js");
    await user({ phone: "+15550001008", optIn: true, evergreen: true });
    expect(await handleSwapInbound({ providerRef: "x-int", from: "15550001008", body: "$5 off", timestamp: new Date(), kind: "text" })).toEqual({
      handled: false,
    });
    expect(holder.sent).toHaveLength(0);
  });
});

describe("matching the sender (E.164)", () => {
  it("exact E.164: a US and an Indian number with the same last 10 digits don't collide", async () => {
    const { matchPhone } = await import("./index.js");
    const us = await user({ phone: "+12015550123" });
    const india = await user({ phone: "+912015550123" });
    expect(await matchPhone("12015550123")).toMatchObject({ kind: "one", user: { id: us } });
    expect(await matchPhone("912015550123")).toMatchObject({ kind: "one", user: { id: india } });
    expect(await matchPhone("2015550123")).toEqual({ kind: "none" });
  });

  it("a legacy row typed without '+' matches on its full digits; deleted accounts never match", async () => {
    const { matchPhone } = await import("./index.js");
    const legacy = await user({ phone: "1 (732) 555-0199" });
    expect(await matchPhone("17325550199")).toMatchObject({ kind: "one", user: { id: legacy } });
    const gone = await user({ phone: "+17325550200" });
    await pg.query(`update users set deleted_at = now() where id = $1`, [gone]);
    expect(await matchPhone("17325550200")).toEqual({ kind: "none" });
  });

  it("migration 0048 rewrote a '+' number to E.164", async () => {
    await pg.query(`insert into users (email, password_hash, phone) values ('legacy-plus@x.test', 'x', '+1 (609) 555-0142')`);
    await pg.exec(readFileSync(join(__dirname, "../../../drizzle/0048_whatsapp_opt_in.sql"), "utf8").replaceAll("--> statement-breakpoint", ""));
    const r = await pg.query<{ phone: string }>(`select phone from users where email = 'legacy-plus@x.test'`);
    expect(r.rows[0]!.phone).toBe("+16095550142");
  });
});

describe("webhook: unknown and ambiguous senders", () => {
  it("unknown sender: one 'add it in Settings' reply, then none for 24 h", async () => {
    const { UNKNOWN_SENDER_REPLY } = await import("./index.js");
    expect((await inbound("15559990001", "hi")).statusCode).toBe(200);
    expect(holder.sent).toHaveLength(1);
    expect(holder.sent[0]).toMatchObject({ to: "15559990001", type: "text" });
    expect((holder.sent[0]!.body as { text: { body: string } }).text.body).toBe(UNKNOWN_SENDER_REPLY);
    expect((await inbound("15559990001", "hello?")).statusCode).toBe(200);
    expect(holder.sent).toHaveLength(1);
  });

  it("several accounts on one number: asks them to use the campaign page", async () => {
    const { AMBIGUOUS_SENDER_REPLY } = await import("./index.js");
    await user({ phone: "+15559990002", optIn: true });
    await user({ phone: "+15559990002", optIn: true });
    await inbound("15559990002", "$5 off");
    expect(holder.sent).toHaveLength(1);
    expect((holder.sent[0]!.body as { text: { body: string } }).text.body).toBe(AMBIGUOUS_SENDER_REPLY);
  });

  it("loop off: an unknown sender gets no reply", async () => {
    process.env.OFFER_SWAP_WHATSAPP = "off";
    await inbound("15559990003", "hi");
    expect(holder.sent).toHaveLength(0);
  });

  it("an unsigned webhook is refused (no WHATSAPP_APP_SECRET match = nothing processed)", async () => {
    const raw = JSON.stringify({ entry: [] });
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/whatsapp",
      payload: raw,
      headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=00" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("signup + PATCH /auth/me + /auth/me whatsapp", () => {
  const register = (payload: object) => app.inject({ method: "POST", url: "/auth/register", payload });
  const me = (id: string) => app.inject({ method: "GET", url: "/auth/me", headers: { "x-test-user": id } });
  const patch = (id: string, payload: object) => app.inject({ method: "PATCH", url: "/auth/me", payload, headers: { "x-test-user": id } });

  it("register: optional phone saved as E.164; opt-in needs a phone; bad numbers 400", async () => {
    const ok = await register({ email: "wa1@x.test", password: "0123456789", phone: "+1 (551) 316-9594", whatsappOptIn: true });
    expect(ok.statusCode).toBe(201);
    const row = (await pg.query<{ phone: string; whatsapp_opt_in_at: Date | null }>(`select phone, whatsapp_opt_in_at from users where email = 'wa1@x.test'`)).rows[0]!;
    expect(row.phone).toBe("+15513169594");
    expect(row.whatsapp_opt_in_at).not.toBeNull();

    const noOpt = await register({ email: "wa2@x.test", password: "0123456789", phone: "+91 98765 43210" });
    expect(noOpt.statusCode).toBe(201);
    expect((await pg.query(`select whatsapp_opt_in_at from users where email = 'wa2@x.test'`)).rows[0]).toEqual({ whatsapp_opt_in_at: null });

    expect((await register({ email: "wa3@x.test", password: "0123456789", whatsappOptIn: true })).json()).toEqual({ error: "whatsapp_opt_in_needs_phone" });
    const bad = await register({ email: "wa4@x.test", password: "0123456789", phone: "(551) 316-9594" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ error: "invalid_phone" });
    expect((await pg.query(`select 1 from users where email in ('wa3@x.test','wa4@x.test')`)).rows).toHaveLength(0);
  });

  it("PATCH: normalises, opts in / out, removing the number clears the opt-in", async () => {
    const id = await user({});
    expect((await patch(id, { phone: "12" })).json()).toEqual({ error: "invalid_phone" });
    expect((await patch(id, { whatsappOptIn: true })).json()).toEqual({ error: "whatsapp_opt_in_needs_phone" });

    const set = await patch(id, { phone: "+1 (332) 555-0101", whatsappOptIn: true });
    expect(set.statusCode).toBe(200);
    expect(set.json()).toMatchObject({ phone: "+13325550101", whatsapp: { phone: "+13325550101", optedIn: true } });
    expect((await patch(id, { whatsappOptIn: true })).statusCode).toBe(200); // again: no-op
    expect((await patch(id, { whatsappOptIn: false })).json()).toMatchObject({ whatsapp: { optedIn: false } });
    await patch(id, { whatsappOptIn: true });
    const removed = await patch(id, { phone: null });
    expect(removed.json()).toMatchObject({ phone: null, whatsapp: { phone: null, optedIn: false, enabled: false } });
  });

  it("/auth/me shows the public number ONLY when the loop answers this owner", async () => {
    const internal = await user({ phone: "+15550002001", optIn: true, internal: true, evergreen: true });
    const customer = await user({ phone: "+15550002002", optIn: true, evergreen: true });
    const a = (await me(internal)).json().whatsapp;
    expect(a).toMatchObject({ available: true, enabled: true, publicNumber: "+1 (332) 316-8453", waLink: "https://wa.me/13323168453" });
    const b = (await me(customer)).json().whatsapp;
    expect(b).toMatchObject({ available: false, enabled: false });
    expect(b.publicNumber).toBeUndefined();

    process.env.OFFER_SWAP_WHATSAPP = "on";
    expect((await me(customer)).json().whatsapp).toMatchObject({ enabled: true, publicNumber: "+1 (332) 316-8453" });
    process.env.OFFER_SWAP_WHATSAPP = "off";
    expect((await me(internal)).json().whatsapp).toMatchObject({ enabled: false });
  });
});

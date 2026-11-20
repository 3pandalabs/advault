// "Your website" editor handoff (2026-11-19): GET /website/editor through
// Fastify against PGlite, SiteVault stubbed. The token is checked here with a
// verifier that mirrors SiteVault's web/src/embed.ts verifyHandoff (signature
// over "sv-embed-v1." + payload, <= 60 s life), so an expired, reused,
// tampered or other-account token is shown to fail the same rules SiteVault
// applies. (Single use and ownership are enforced by SiteVault itself; its
// own tests cover them end to end.)
import { createHmac, timingSafeEqual } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
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
  },
}));

const SECRET = process.env.SITEVAULT_INTERNAL_TOKEN!;
const SITE = "https://lawn-pros.3pandasite.com/";
let app: FastifyInstance;
let pg: PGlite;
let userId: string;
let otherId: string;
let accountSite: (url: URL) => Response;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** SiteVault's checks (web/src/embed.ts), minus KV and ownership. */
function sitevaultVerify(token: string, nowMs = Date.now()): { ok: true; h: Record<string, unknown> } | { ok: false; error: string } {
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return { ok: false, error: "malformed" };
  const want = createHmac("sha256", SECRET).update(`sv-embed-v1.${payload}`).digest();
  const got = Buffer.from(sig, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return { ok: false, error: "bad_signature" };
  const h = JSON.parse(Buffer.from(payload, "base64url").toString()) as { iat: number; exp: number };
  const now = Math.floor(nowMs / 1000);
  if (h.exp - h.iat > 60 || h.iat > now + 5 || now >= h.exp) return { ok: false, error: "expired" };
  return { ok: true, h: h as unknown as Record<string, unknown> };
}

beforeAll(async () => {
  pg = new PGlite();
  const dir = join(__dirname, "../../drizzle");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    await pg.exec(readFileSync(join(dir, f), "utf8").replaceAll("--> statement-breakpoint", ""));
  }
  holder.db = drizzle(pg, { schema });
  userId = (await pg.query<{ id: string }>(`insert into users (email, password_hash) values ('owner@x.test', 'x') returning id`)).rows[0]!.id;
  otherId = (await pg.query<{ id: string }>(`insert into users (email, password_hash) values ('other@x.test', 'x') returning id`)).rows[0]!.id;
  const { websiteEditorRoutes } = await import("./websiteEditor.js");
  app = Fastify();
  await app.register(websiteEditorRoutes);
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
});

beforeEach(() => {
  accountSite = () => json({ ok: true, slug: "lawn-pros", siteUrl: SITE, state: "live", source: "advault", count: 1 });
  vi.stubGlobal("fetch", async (input: string | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/internal/account-site") return accountSite(url);
    throw new Error(`unexpected fetch ${url}`);
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const get = (user: string | null = userId) =>
  app.inject({ method: "GET", url: "/website/editor", headers: user ? { "x-test-user": user } : {} });

const tokenOf = (editorUrl: string) => new URL(editorUrl).searchParams.get("token")!;

describe("GET /website/editor", () => {
  it("needs a signed-in user", async () => {
    expect((await get(null)).statusCode).toBe(401);
  });

  it("an AdVault-made site: a SiteVault handoff URL for this user and site, never cached", async () => {
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.json() as { site: Record<string, unknown>; editorUrl: string };
    expect(body.site).toEqual({ slug: "lawn-pros", siteUrl: SITE, live: true, madeHere: true });
    expect(body.editorUrl.startsWith("https://sitevault.3pandalabs.com/embed/session?token=")).toBe(true);
    const checked = sitevaultVerify(tokenOf(body.editorUrl));
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.h).toMatchObject({ v: 1, uid: userId, email: "owner@x.test", slug: "lawn-pros" });
    expect((checked.h.exp as number) - (checked.h.iat as number)).toBe(60);
    // No password and no long-lived secret in the URL.
    expect(body.editorUrl).not.toContain(SECRET);
  });

  it("looks the site up for the signed-in user only", async () => {
    const seen: string[] = [];
    accountSite = (url) => {
      seen.push(url.searchParams.get("advaultUserId")!);
      return json({ ok: true, slug: "lawn-pros", siteUrl: SITE, state: "live", source: "advault", count: 1 });
    };
    const body = (await get(otherId)).json() as { editorUrl: string };
    expect(seen).toEqual([otherId]);
    const checked = sitevaultVerify(tokenOf(body.editorUrl));
    expect(checked.ok && checked.h.uid).toBe(otherId);
  });

  it("each request mints a new single-use token (fresh jti)", async () => {
    const a = tokenOf(((await get()).json() as { editorUrl: string }).editorUrl);
    const b = tokenOf(((await get()).json() as { editorUrl: string }).editorUrl);
    const ja = sitevaultVerify(a);
    const jb = sitevaultVerify(b);
    expect(ja.ok && jb.ok && ja.h.jti !== jb.h.jti).toBe(true);
  });

  it("the token fails once expired, and when tampered with or re-signed for another account", async () => {
    const token = tokenOf(((await get()).json() as { editorUrl: string }).editorUrl);
    expect(sitevaultVerify(token, Date.now() + 61_000)).toEqual({ ok: false, error: "expired" });
    const [payload, sig] = token.split(".") as [string, string];
    const h = JSON.parse(Buffer.from(payload, "base64url").toString());
    // Point it at another account's id / another site, keeping the signature.
    for (const change of [{ uid: otherId }, { slug: "someone-else" }]) {
      const forged = `${Buffer.from(JSON.stringify({ ...h, ...change })).toString("base64url")}.${sig}`;
      expect(sitevaultVerify(forged)).toEqual({ ok: false, error: "bad_signature" });
    }
    // Signed with anything but the shared secret.
    const wrong = createHmac("sha256", "guess").update(`sv-embed-v1.${payload}`).digest("base64url");
    expect(sitevaultVerify(`${payload}.${wrong}`)).toEqual({ ok: false, error: "bad_signature" });
  });

  it("no website: no editor", async () => {
    accountSite = () => json({ ok: false, error: "no_site" }, 404);
    expect((await get()).json()).toEqual({ site: null, editorUrl: null });
  });

  it("a site built on SiteVault: shown, but no editor here", async () => {
    accountSite = () => json({ ok: true, slug: "lawn-pros", siteUrl: SITE, state: "live", source: "web", count: 1 });
    expect((await get()).json()).toEqual({ site: { slug: "lawn-pros", siteUrl: SITE, live: true, madeHere: false }, editorUrl: null });
  });

  it("SiteVault unreachable: no editor, no error", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("down");
    });
    expect((await get()).json()).toEqual({ site: null, editorUrl: null });
  });
});

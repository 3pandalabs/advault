// The SiteVault-facing shared-account routes, end to end through Fastify
// against PGlite with every migration applied.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import Fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "../db/schema.js";
import type { Db } from "../lib/sharedAccount/index.js";
import { sitevaultAuthRoutes } from "./sitevaultAuth.js";

const TOKEN = "test-internal-token";
const auth = { authorization: `Bearer ${TOKEN}` };
let app: FastifyInstance;
let pg: PGlite;

beforeAll(async () => {
  process.env.SITEVAULT_INTERNAL_TOKEN = TOKEN;
  pg = new PGlite();
  const dir = join(__dirname, "../../drizzle");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    await pg.exec(readFileSync(join(dir, f), "utf8").replaceAll("--> statement-breakpoint", ""));
  }
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(sitevaultAuthRoutes, { db: drizzle(pg, { schema }) as unknown as Db });
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  delete process.env.SITEVAULT_INTERNAL_TOKEN;
});

const post = (url: string, payload: unknown, headers: Record<string, string> = auth) =>
  app.inject({ method: "POST", url, payload: payload as object, headers });

describe("internal SiteVault account routes", () => {
  it("refuse a missing or wrong bearer", async () => {
    for (const url of ["/internal/sitevault/accounts", "/internal/sitevault/usage", "/internal/sitevault/verify-login"]) {
      const body = { email: "a@x.test", password: "password123", userId: "00000000-0000-0000-0000-000000000000" };
      expect((await post(url, body, {})).statusCode).toBe(401);
      expect((await post(url, body, { authorization: "Bearer nope" })).statusCode).toBe(401);
    }
  });

  it("email SiteVault's contact form to its own address, and say so when it did not go out", async () => {
    const msg = { name: "Sam", email: "sam@x.test", subject: "Hi", message: "Hello" };
    expect((await post("/internal/sitevault/contact", msg, {})).statusCode).toBe(401);
    expect((await post("/internal/sitevault/contact", msg)).statusCode).toBe(503); // no mailer
    vi.stubEnv("MAILER_URL", "https://mailer.test");
    vi.stubEnv("MAILER_TOKEN", "t");
    const fetchMock = vi.fn(async (_u: string, _i: RequestInit) => new Response(JSON.stringify({ delivered: 1 })));
    vi.stubGlobal("fetch", fetchMock);
    expect((await post("/internal/sitevault/contact", msg)).statusCode).toBe(204);
    expect((await post("/internal/sitevault/contact", { ...msg, email: "no" })).statusCode).toBe(400);
    const sent = JSON.parse(String(fetchMock.mock.calls[0]![1].body)).messages[0];
    expect(sent).toMatchObject({ to: "sitevault@3pandalabs.com", from: "sitevault@3pandalabs.com", replyTo: "sam@x.test", subject: "SiteVault contact: Hi" });
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("create a SiteVault account whose password then verifies (same login on both)", async () => {
    const made = await post("/internal/sitevault/accounts", { email: "Owner@X.test", password: "eightchr" });
    expect(made.statusCode).toBe(201);
    const { userId } = made.json() as { userId: string };
    const row = await pg.query<{ signup_app: string }>(`select signup_app from users where id = $1`, [userId]);
    expect(row.rows[0]!.signup_app).toBe("sitevault");

    const ok = await post("/internal/sitevault/verify-login", { email: "owner@x.test", password: "eightchr" });
    expect(ok.json()).toEqual({ ok: true, userId, email: "owner@x.test" });
    expect((await post("/internal/sitevault/verify-login", { email: "owner@x.test", password: "wrong-one" })).statusCode).toBe(401);
  });

  it("answer 409 email_exists with the existing id and leave its password alone", async () => {
    const first = await post("/internal/sitevault/accounts", { email: "dup@x.test", password: "first-password" });
    const again = await post("/internal/sitevault/accounts", { email: "dup@x.test", password: "second-password" });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: "email_exists", userId: (first.json() as { userId: string }).userId });
    expect((await post("/internal/sitevault/verify-login", { email: "dup@x.test", password: "first-password" })).statusCode).toBe(200);
    expect((await post("/internal/sitevault/verify-login", { email: "dup@x.test", password: "second-password" })).statusCode).toBe(401);
  });

  it("reject a password shorter than SiteVault's legacy 8 and a bad email", async () => {
    expect((await post("/internal/sitevault/accounts", { email: "s@x.test", password: "short" })).statusCode).toBe(400);
    expect((await post("/internal/sitevault/accounts", { email: "nope", password: "password123" })).statusCode).toBe(400);
  });

  it("stamp SiteVault usage, 404 for an unknown account", async () => {
    const made = await post("/internal/sitevault/accounts", { email: "use@x.test", password: "password123" });
    const { userId } = made.json() as { userId: string };
    const used = await post("/internal/sitevault/usage", { userId, at: "2026-11-15T12:00:00.000Z" });
    expect(used.statusCode).toBe(200);
    const row = await pg.query<{ sitevault_first_used_at: Date }>(`select sitevault_first_used_at from users where id = $1`, [userId]);
    expect(row.rows[0]!.sitevault_first_used_at.toISOString()).toBe("2026-11-15T12:00:00.000Z");
    expect((await post("/internal/sitevault/usage", { userId: "00000000-0000-0000-0000-000000000000" })).statusCode).toBe(404);
    expect((await post("/internal/sitevault/usage", { userId: "not-a-uuid" })).statusCode).toBe(400);
  });
});

describe("internal SiteVault password reset routes", () => {
  const reqBody = { email: "a@x.test", resetUrlBase: "https://s.test/reset-password", productName: "SiteVault", fromName: "SiteVault" };

  it("refuse a missing or wrong bearer", async () => {
    const cases: [string, object][] = [
      ["/internal/sitevault/password-reset/request", reqBody],
      ["/internal/sitevault/password-reset/confirm", { token: "x.y", password: "password123" }],
      ["/internal/sitevault/change-password", { email: "a@x.test", currentPassword: "x", newPassword: "password123" }],
    ];
    for (const [url, body] of cases) {
      expect((await post(url, body, {})).statusCode).toBe(401);
      expect((await post(url, body, { authorization: "Bearer nope" })).statusCode).toBe(401);
    }
  });

  it("request is enumeration-safe 204 for known and unknown emails, and validates the body", async () => {
    await post("/internal/sitevault/accounts", { email: "reset-http@x.test", password: "password123" });
    expect((await post("/internal/sitevault/password-reset/request", { ...reqBody, email: "reset-http@x.test" })).statusCode).toBe(204);
    expect((await post("/internal/sitevault/password-reset/request", { ...reqBody, email: "ghost@x.test" })).statusCode).toBe(204);
    const { resetUrlBase: _omit, ...noBase } = reqBody;
    expect((await post("/internal/sitevault/password-reset/request", noBase)).statusCode).toBe(400);
    expect((await post("/internal/sitevault/password-reset/request", { ...reqBody, resetUrlBase: "not-a-url" })).statusCode).toBe(400);
  });

  it("confirm rejects a bad or unknown token and a too-short password", async () => {
    expect((await post("/internal/sitevault/password-reset/confirm", { token: "nope", password: "password123" })).statusCode).toBe(400);
    expect(
      (await post("/internal/sitevault/password-reset/confirm", { token: "00000000-0000-0000-0000-000000000000.x", password: "password123" })).statusCode,
    ).toBe(400);
    expect((await post("/internal/sitevault/password-reset/confirm", { token: "x.y", password: "short" })).statusCode).toBe(400);
  });

  it("change-password verifies the current password, then the new one signs in", async () => {
    await post("/internal/sitevault/accounts", { email: "chg-http@x.test", password: "eightchr" });
    expect((await post("/internal/sitevault/change-password", { email: "chg-http@x.test", currentPassword: "wrong-pass", newPassword: "newpass12" })).statusCode).toBe(401);
    expect((await post("/internal/sitevault/change-password", { email: "chg-http@x.test", currentPassword: "eightchr", newPassword: "newpass12" })).statusCode).toBe(200);
    expect((await post("/internal/sitevault/verify-login", { email: "chg-http@x.test", password: "newpass12" })).statusCode).toBe(200);
    expect((await post("/internal/sitevault/verify-login", { email: "chg-http@x.test", password: "eightchr" })).statusCode).toBe(401);
  });

  it("emails a SiteVault security notice after a successful change (from the passwordReset default sender), none on a wrong password", async () => {
    await post("/internal/sitevault/accounts", { email: "chg-mail@x.test", password: "eightchr" });
    vi.stubEnv("MAILER_URL", "https://mailer.test");
    vi.stubEnv("MAILER_TOKEN", "t");
    const fetchMock = vi.fn(async (_u: string, _i: RequestInit) => new Response(JSON.stringify({ delivered: 1 })));
    vi.stubGlobal("fetch", fetchMock);

    expect((await post("/internal/sitevault/change-password", { email: "chg-mail@x.test", currentPassword: "eightchr", newPassword: "newpass34" })).statusCode).toBe(200);
    const sent = JSON.parse(String(fetchMock.mock.calls[0]![1].body)).messages[0];
    expect(sent).toMatchObject({ to: "chg-mail@x.test", fromName: "SiteVault", subject: "Your SiteVault password was changed" });
    expect(sent.from).toBeUndefined(); // unset -> gateway's advault default = passwordReset@3pandalabs.com

    // A wrong current password changes nothing and sends nothing.
    fetchMock.mockClear();
    expect((await post("/internal/sitevault/change-password", { email: "chg-mail@x.test", currentPassword: "wrong-pass", newPassword: "newpass56" })).statusCode).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();

    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
});

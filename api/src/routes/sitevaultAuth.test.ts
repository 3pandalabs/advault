// The SiteVault-facing shared-account routes, end to end through Fastify
// against PGlite with every migration applied.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import Fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

// PATCH /auth/me through Fastify against PGlite (every migration applied).
// QA 2026-11-16: a body with no profile fields ({} or only email/role, which
// zod strips) reached db.update().set({}) and drizzle threw: a 500.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
  };
  for (const [k, v] of Object.entries(dummy)) process.env[k] ??= v;
  return { db: null as unknown };
});

vi.mock("../db/index.js", () => ({
  get db() {
    return holder.db;
  },
}));
// The session check is not under test: the caller's id comes from a header.
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

beforeAll(async () => {
  pg = new PGlite();
  const dir = join(__dirname, "../../drizzle");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    await pg.exec(readFileSync(join(dir, f), "utf8").replaceAll("--> statement-breakpoint", ""));
  }
  holder.db = drizzle(pg, { schema });
  const res = await pg.query<{ id: string }>(
    `insert into users (email, password_hash, display_name) values ('me@x.test', 'x', 'Old Name') returning id`,
  );
  userId = res.rows[0]!.id;
  const { authRoutes } = await import("./auth.js");
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(authRoutes);
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
});

const patch = (payload: unknown) =>
  app.inject({ method: "PATCH", url: "/auth/me", payload: payload as object, headers: { "x-test-user": userId } });

describe("PATCH /auth/me", () => {
  it("400 nothing_to_update for an empty body", async () => {
    const res = await patch({});
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "nothing_to_update" });
  });

  it("400 nothing_to_update when only email / role are sent (never applied)", async () => {
    const res = await patch({ email: "evil@x.test", role: "admin" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "nothing_to_update" });
    const row = await pg.query<{ email: string; role: string }>(`select email, role from users where id = $1`, [userId]);
    expect(row.rows[0]).toMatchObject({ email: "me@x.test", role: "advertiser" });
  });

  it("updates a profile field and still ignores email / role beside it", async () => {
    const res = await patch({ displayName: "New Name", email: "evil@x.test", role: "admin" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ displayName: "New Name", email: "me@x.test", role: "advertiser" });
  });

  it("null clears a field", async () => {
    const res = await patch({ phone: null });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ phone: null });
  });
});

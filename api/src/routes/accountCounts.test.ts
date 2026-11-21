// GET /admin/account-counts through Fastify against PGlite: real customers vs
// admins' test customers (0030, per owner) vs 3PandaLabs' internal accounts
// (0032, per product label) vs admins, for the org admin site's AdVault card.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import Fastify, { type FastifyInstance } from "fastify";
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
    METRICS_TOKEN: "metrics-token-for-tests",
    ADMIN_ANALYTICS_TOKEN: "analytics-token-for-tests",
  };
  for (const [k, v] of Object.entries(dummy)) process.env[k] ??= v;
  return { db: null as unknown };
});

vi.mock("../db/index.js", () => ({
  get db() {
    return holder.db;
  },
}));

let app: FastifyInstance;
let pg: PGlite;
let adminId: string;
let customerId: string;

async function newUser(
  email: string,
  role: "admin" | "advertiser",
  extra: { testOwnerId?: string; internal?: boolean; label?: string; deleted?: boolean; marked?: boolean } = {},
): Promise<string> {
  const r = await pg.query<{ id: string }>(
    `insert into users (email, password_hash, role, test_owner_id, is_internal, internal_label, deleted_at, marked_test)
     values ($1, 'x', $2, $3, $4, $5, $6, $7) returning id`,
    [email, role, extra.testOwnerId ?? null, extra.internal ?? false, extra.label ?? null, extra.deleted ? new Date().toISOString() : null, extra.marked ?? false],
  );
  return r.rows[0]!.id;
}

beforeAll(async () => {
  pg = new PGlite();
  const dir = join(__dirname, "../../drizzle");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    await pg.exec(readFileSync(join(dir, f), "utf8").replaceAll("--> statement-breakpoint", ""));
  }
  holder.db = drizzle(pg, { schema });

  adminId = await newUser("admin@x.test", "admin");
  const admin2 = await newUser("admin2@x.test", "admin");
  // Real: two live advertisers; a deleted one does not count.
  customerId = await newUser("shop@x.test", "advertiser");
  await newUser("cafe@x.test", "advertiser");
  await newUser("gone@x.test", "advertiser", { deleted: true });
  // Test customers: 3 under admin@, 1 under admin2@, 1 deleted.
  for (const n of [1, 2, 3]) await newUser(`t${n}@test.invalid`, "advertiser", { testOwnerId: adminId });
  await newUser("t4@test.invalid", "advertiser", { testOwnerId: admin2 });
  await newUser("t5@test.invalid", "advertiser", { testOwnerId: adminId, deleted: true });
  // Internal: SiteVault x2, RsvpVault, one unlabelled.
  await newUser("sv1@3pandalabs.test", "advertiser", { internal: true, label: "SiteVault" });
  await newUser("sv2@3pandalabs.test", "advertiser", { internal: true, label: "SiteVault" });
  await newUser("rsvp@3pandalabs.test", "advertiser", { internal: true, label: "RsvpVault" });
  await newUser("misc@3pandalabs.test", "advertiser", { internal: true });
  // Marked as test (0046, keeps its login): one plain, one also internal (test
  // wins), one deleted.
  await newUser("reviewer@x.test", "advertiser", { marked: true });
  await newUser("qa@3pandalabs.test", "advertiser", { marked: true, internal: true, label: "QA" });
  await newUser("old@x.test", "advertiser", { marked: true, deleted: true });

  const { authPlugin } = await import("../auth/plugin.js");
  const { adminInsightsRoutes } = await import("./adminInsights.js");
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(authPlugin);
  await app.register(adminInsightsRoutes);
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
});

const get = (url: string, token?: string) =>
  app.inject({ method: "GET", url, headers: token ? { authorization: `Bearer ${token}` } : {} });

describe("GET /admin/account-counts", () => {
  it("splits accounts into real, test (per owner + marked), internal (per label) and admins", async () => {
    const res = await get("/admin/account-counts", "analytics-token-for-tests");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.real).toBe(2);
    expect(body.test).toEqual({
      total: 6,
      createdByAdmins: 4,
      markedByAdmin: 2,
      byOwner: [
        { ownerEmail: "admin@x.test", count: 3 },
        { ownerEmail: "admin2@x.test", count: 1 },
      ],
    });
    expect(body.internal).toEqual({
      total: 4,
      labels: [
        { label: "RsvpVault", count: 1 },
        { label: "SiteVault", count: 2 },
        { label: null, count: 1 },
      ],
    });
    expect(body.admins).toBe(2);
    // No customer emails, only admins' (test owners).
    expect(JSON.stringify(body)).not.toContain("shop@x.test");
    expect(JSON.stringify(body)).not.toContain("invalid");
    expect(JSON.stringify(body)).not.toContain("reviewer@x.test");
    expect(JSON.stringify(body)).not.toContain("QA");
  });

  it("agrees with /admin/business customers", async () => {
    const business = (await get("/admin/business", "analytics-token-for-tests")).json();
    const counts = (await get("/admin/account-counts", "analytics-token-for-tests")).json();
    expect(counts.real).toBe(business.totals.customers);
    expect(counts.internal.total).toBe(business.internal.length);
  });

  it("needs the analytics token or an admin session", async () => {
    expect((await get("/admin/account-counts")).statusCode).toBe(401);
    expect((await get("/admin/account-counts", "metrics-token-for-tests")).statusCode).toBe(401);
    const { signAccessToken } = await import("../auth/jwt.js");
    expect((await get("/admin/account-counts", signAccessToken({ sub: customerId, role: "advertiser" }))).statusCode).toBe(403);
    expect((await get("/admin/account-counts", signAccessToken({ sub: adminId, role: "admin" }))).statusCode).toBe(200);
  });
});

// GET /admin/cashflow through Fastify against PGlite: the wallet ledger per
// UTC month and currency (ad budget vs AdVault fees) for the org admin site's
// Cash flow by product table. Aggregates only; token and session guards hold.
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


async function newUser(email: string, role: "admin" | "advertiser"): Promise<string> {
  const r = await pg.query<{ id: string }>(`insert into users (email, password_hash, role) values ($1, 'x', $2) returning id`, [email, role]);
  return r.rows[0]!.id;
}

async function entry(walletId: string, type: string, amountMinor: number, at: string, currency = "USD") {
  await pg.query(
    `insert into ledger_entries (wallet_id, type, amount_minor, currency_code, created_at) values ($1, $2, $3, $4, $5)`,
    [walletId, type, amountMinor, currency, at],
  );
}

beforeAll(async () => {
  pg = new PGlite();
  const dir = join(__dirname, "../../drizzle");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    await pg.exec(readFileSync(join(dir, f), "utf8").replaceAll("--> statement-breakpoint", ""));
  }
  holder.db = drizzle(pg, { schema });
  adminId = await newUser("admin@x.test", "admin");
  customerId = await newUser("shop@x.test", "advertiser");
  const w = (await pg.query<{ id: string }>(`insert into wallets (user_id, currency_code) values ($1, 'USD') returning id`, [customerId])).rows[0]!.id;

  // November: a $50 budget top-up; a $10 ad paid by card (credit + fee pair);
  // a $20 plan drawn from the budget; a $5 budget refund; $17.34 of Google spend.
  await entry(w, "topup", 5000, "2026-11-02T10:00:00Z");
  await entry(w, "topup", 1000, "2026-11-03T10:00:00Z");
  await entry(w, "fee", -1000, "2026-11-03T10:00:00Z");
  await entry(w, "fee", -2000, "2026-11-04T10:00:00Z");
  await entry(w, "refund", -500, "2026-11-05T10:00:00Z");
  await entry(w, "spend", -1734, "2026-11-06T10:00:00Z");
  // December and October rows; October is outside the range.
  await entry(w, "topup", 3500, "2026-12-01T00:00:00Z");
  await entry(w, "topup", 9999, "2026-10-31T23:59:59Z");

  const { authPlugin } = await import("../auth/plugin.js");
  const { adminCashflowRoutes } = await import("./adminCashflow.js");
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(authPlugin);
  await app.register(adminCashflowRoutes);
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
});

const get = (url: string, token?: string) =>
  app.inject({ method: "GET", url, headers: token ? { authorization: `Bearer ${token}` } : {} });

describe("ledgerMonths", () => {
  it("turns signed sums into positive amounts and nets fees and refunds out of the budget", async () => {
    const { ledgerMonths } = await import("./adminCashflow.js");
    expect(
      ledgerMonths([
        { month: "2026-11", currency: "USD", type: "topup", total: "6000" },
        { month: "2026-11", currency: "USD", type: "fee", total: -3000 },
        { month: "2026-11", currency: "USD", type: "refund", total: -500 },
        { month: "2026-11", currency: "INR", type: "topup", total: 100 },
        { month: "2026-10", currency: "USD", type: "adjustment", total: -7 },
      ]),
    ).toEqual([
      { month: "2026-10", currency: "USD", topupMinor: 0, feeMinor: 0, refundMinor: 0, spendMinor: 0, adjustmentMinor: -7, budgetInMinor: 0 },
      { month: "2026-11", currency: "INR", topupMinor: 100, feeMinor: 0, refundMinor: 0, spendMinor: 0, adjustmentMinor: 0, budgetInMinor: 100 },
      { month: "2026-11", currency: "USD", topupMinor: 6000, feeMinor: 3000, refundMinor: 500, spendMinor: 0, adjustmentMinor: 0, budgetInMinor: 2500 },
    ]);
  });
});

describe("GET /admin/cashflow", () => {
  it("returns ledger totals per UTC month, aggregates only", async () => {
    const res = await get("/admin/cashflow?since=2026-11-01&until=2027-01-01", "analytics-token-for-tests");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.months).toEqual([
      { month: "2026-11", currency: "USD", topupMinor: 6000, feeMinor: 3000, refundMinor: 500, spendMinor: 1734, adjustmentMinor: 0, budgetInMinor: 2500 },
      { month: "2026-12", currency: "USD", topupMinor: 3500, feeMinor: 0, refundMinor: 0, spendMinor: 0, adjustmentMinor: 0, budgetInMinor: 3500 },
    ]);
    expect(JSON.stringify(body)).not.toContain("shop@x.test");
    expect(JSON.stringify(body)).not.toContain(customerId);
  });

  it("needs the analytics token or an admin session", async () => {
    expect((await get("/admin/cashflow?since=2026-11-01&until=2026-12-01")).statusCode).toBe(401);
    expect((await get("/admin/cashflow?since=2026-11-01&until=2026-12-01", "wrong")).statusCode).toBe(401);
    const { signAccessToken } = await import("../auth/jwt.js");
    expect((await get("/admin/cashflow?since=2026-11-01&until=2026-12-01", signAccessToken({ sub: customerId, role: "advertiser" }))).statusCode).toBe(403);
    expect((await get("/admin/cashflow?since=2026-11-01&until=2026-12-01", signAccessToken({ sub: adminId, role: "admin" }))).statusCode).toBe(200);
  });

  it("rejects a malformed range", async () => {
    expect((await get("/admin/cashflow?since=nov&until=2026-12-01", "analytics-token-for-tests")).statusCode).toBe(400);
  });
});

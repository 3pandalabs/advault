// Customer emails against PGlite with every migration applied (0049 re-run to
// prove it idempotent) and the mailer gateway stubbed: who is skipped, the
// once-only claims, and the welcome email from POST /auth/register.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import Fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../../db/schema.js";

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
    METRICS_TOKEN: "metrics-token-for-tests",
  };
  for (const [k, v] of Object.entries(dummy)) process.env[k] ??= v;
  process.env.MAILER_URL = "https://mailer.test";
  process.env.MAILER_TOKEN = "mailer-token";
  process.env.NEW_USER_ALERT_EMAIL = "off";
  return { db: null as unknown };
});

vi.mock("../../db/index.js", () => ({
  get db() {
    return holder.db;
  },
}));

type Sent = { to: string; subject: string; from: string; text: string };
let sent: Sent[] = [];
let pg: PGlite;
let app: FastifyInstance;
let mod: typeof import("./index.js");

const fetchStub = vi.fn(async (_url: string, init?: { body?: string }) => {
  const body = JSON.parse(init?.body ?? "{}") as { messages: Sent[] };
  sent.push(...body.messages);
  return new Response(JSON.stringify({ delivered: body.messages.length, failed: 0 }), { status: 200 });
});

async function user(email: string, opts: { role?: string; testOwnerId?: string | null; deleted?: boolean } = {}): Promise<string> {
  const r = await pg.query<{ id: string }>(
    `insert into users (email, password_hash, role, test_owner_id, deleted_at, display_name)
     values ($1, 'x', $2, $3, $4, 'Maria') returning id`,
    [email, opts.role ?? "advertiser", opts.testOwnerId ?? null, opts.deleted ? new Date() : null],
  );
  return r.rows[0]!.id;
}

async function account(userId: string): Promise<string> {
  const a = await pg.query<{ id: string }>(
    `insert into ad_accounts (user_id, provider, customer_id, currency_code, is_managed, billing_mode, billing_link_status,
       login_customer_id, manager_customer_id, status, provision_status)
     values ($1, 'google_ads', '1234567890', 'USD', true, 'platform', 'active', '999', '999', 'active', 'active') returning id`,
    [userId],
  );
  return a.rows[0]!.id;
}

async function campaign(userId: string): Promise<string> {
  const r = await pg.query<{ id: string }>(
    `insert into campaigns (user_id, name, business_name, business_category, target_zip_codes, daily_budget_cents, currency_code, status)
     values ($1, 'Spring sale', 'Joe''s Plumbing', 'Plumbing', '{10001}', 500, 'USD', 'rendering') returning id`,
    [userId],
  );
  return r.rows[0]!.id;
}

async function creative(
  campaignId: string,
  aspect: string,
  p: { yt?: string | null; status?: string; version?: number; kind?: string; at?: string } = {},
): Promise<string> {
  const r = await pg.query<{ id: string }>(
    `insert into creatives (campaign_id, aspect_ratio, render_status, youtube_video_id, youtube_upload_status, version, kind, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
    [
      campaignId,
      aspect,
      p.status ?? "ready",
      p.yt ?? null,
      p.yt ? "done" : "pending",
      p.version ?? 1,
      p.kind ?? "standard",
      p.at ?? "2026-11-26T10:00:00Z",
    ],
  );
  return r.rows[0]!.id;
}

const publish = (id: string, yt: string) =>
  pg.query(`update creatives set youtube_video_id = $2, youtube_upload_status = 'done' where id = $1`, [id, yt]);

beforeAll(async () => {
  vi.stubGlobal("fetch", fetchStub);
  pg = new PGlite();
  const dir = join(__dirname, "../../../drizzle");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    await pg.exec(readFileSync(join(dir, f), "utf8").replaceAll("--> statement-breakpoint", ""));
  }
  holder.db = drizzle(pg, { schema });
  mod = await import("./index.js");

  const { authRoutes } = await import("../../routes/auth.js");
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(authRoutes);
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  sent = [];
});

const quiet = () => {};

describe("migration 0049", () => {
  it("is idempotent and does not re-mark creatives on a re-run", async () => {
    const c = await campaign(await user("mig@example.com"));
    const fresh = await creative(c, "16:9", { yt: "yt-old" });
    // The first run (beforeAll) only saw an empty table: this creative is unmarked.
    await pg.exec(
      readFileSync(join(__dirname, "../../../drizzle/0049_customer_emails.sql"), "utf8").replaceAll("--> statement-breakpoint", ""),
    );
    const r = await pg.query<{ ready_emailed_at: Date | null }>(`select ready_emailed_at from creatives where id = $1`, [fresh]);
    expect(r.rows[0]!.ready_emailed_at).toBeNull();
  });
});

describe("welcome email", () => {
  it("POST /auth/register sends one welcome to the new account, from advault@", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "New.Shop@Example.com", password: "long-enough-pw", businessName: "New Shop" },
    });
    expect(res.statusCode).toBe(201);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ to: "new.shop@example.com", subject: "Welcome to AdVault", from: "advault@3pandalabs.com" });
    expect(sent[0]!.text).toContain("/dashboard/campaigns/new");
  });

  it("a mailer failure never fails the sign-up", async () => {
    fetchStub.mockImplementationOnce(async () => new Response("quota", { status: 429 }));
    const res = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "quota@example.com", password: "long-enough-pw" },
    });
    expect(res.statusCode).toBe(201);
  });
});

describe("ad account ready", () => {
  it("sends once per account, linking the unlaunched campaign", async () => {
    const u = await user("acct@example.com");
    const c = await campaign(u);
    const a = await account(u);
    await mod.adAccountReadyNow({ id: a, userId: u }, quiet);
    await mod.adAccountReadyNow({ id: a, userId: u }, quiet);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toBe("Your AdVault ad account is ready");
    expect(sent[0]!.text).toContain(`/dashboard/campaigns/${c}`);
  });

  it("concurrent claims: exactly one wins", async () => {
    const u = await user("race@example.com");
    const a = await account(u);
    const wins = await Promise.all([mod.claimAdAccountReady(a), mod.claimAdAccountReady(a), mod.claimAdAccountReady(a)]);
    expect(wins.filter(Boolean)).toHaveLength(1);
  });

  it("skips test customers, deleted accounts and admins; internal-style org addresses get it", async () => {
    const admin = await user("boss@example.com", { role: "admin" });
    const skipped = [
      await user("t-1@test.advault.invalid", { testOwnerId: admin }),
      await user("gone@example.com", { deleted: true }),
      admin,
    ];
    for (const u of skipped) await mod.adAccountReadyNow({ id: await account(u), userId: u }, quiet);
    expect(sent).toHaveLength(0);
    const internal = await user("advault@3pandalabs.com");
    await mod.adAccountReadyNow({ id: await account(internal), userId: internal }, quiet);
    expect(sent.map((s) => s.to)).toEqual(["advault@3pandalabs.com"]);
  });
});

describe("your ad is ready", () => {
  it("one email when the last format is on YouTube, none for repeats, a new one for the next version", async () => {
    const c = await campaign(await user("ad@example.com"));
    const wide = await creative(c, "16:9", { at: "2026-11-26T10:00:00Z" });
    const tall = await creative(c, "9:16", { at: "2026-11-26T10:00:01Z" });

    await publish(wide, "yt-wide");
    await mod.adReadyNow(wide, quiet);
    expect(sent).toHaveLength(0); // 9:16 still publishing

    await publish(tall, "yt-tall");
    await Promise.all([mod.adReadyNow(tall, quiet), mod.adReadyNow(wide, quiet)]);
    await mod.adReadyNow(tall, quiet);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toBe("Your ad is ready: Spring sale");
    expect(sent[0]!.text).toContain(`/dashboard/campaigns/${c}`);

    const redo = await creative(c, "16:9", { version: 2, yt: "yt-v2", at: "2026-11-27T10:00:00Z" });
    await mod.adReadyNow(redo, quiet);
    expect(sent).toHaveLength(2);
  });

  it("offer-change re-cuts and uploads send nothing", async () => {
    const c = await campaign(await user("up@example.com"));
    const up = await creative(c, "9:16", { kind: "upload", yt: "yt-up" });
    await mod.adReadyNow(up, quiet);
    expect(sent).toHaveLength(0);
  });

  it("test customers are skipped (but the make is still marked)", async () => {
    const admin = await user("own@example.com", { role: "admin" });
    const c = await campaign(await user("t-2@test.advault.invalid", { testOwnerId: admin }));
    const cr = await creative(c, "16:9", { yt: "yt-t" });
    await mod.adReadyNow(cr, quiet);
    expect(sent).toHaveLength(0);
    const r = await pg.query<{ ready_emailed_at: Date | null }>(`select ready_emailed_at from creatives where id = $1`, [cr]);
    expect(r.rows[0]!.ready_emailed_at).not.toBeNull();
  });
});

describe("low ad budget", () => {
  it("shows the balance and days, links to the campaign's budget card", async () => {
    const u = await user("low@example.com");
    const c = await campaign(u);
    await mod.lowBudgetNow(
      { userId: u, balanceMinor: 850, dailyMinor: 500, currency: "USD", daysLeft: 1, campaigns: [{ id: c, name: "Spring sale" }] },
      quiet,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("Your ad budget has $8.50 left. That's about 1 day at $5 a day.");
    expect(sent[0]!.text).toContain(`/dashboard/campaigns/${c}#ad-budget`);
  });

  it("is skipped for a deleted account", async () => {
    const u = await user("lowgone@example.com", { deleted: true });
    await mod.lowBudgetNow({ userId: u, balanceMinor: 850, dailyMinor: 500, currency: "USD", daysLeft: 1, campaigns: [] }, quiet);
    expect(sent).toHaveLength(0);
  });
});

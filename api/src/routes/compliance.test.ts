// Client attestation & compliance (migration 0043, lib/compliance) through
// Fastify against PGlite with every drizzle/*.sql applied and the REAL JWT
// auth plugin. Google, Stripe, R2, the script writer and ntfy are stubbed.
//
// Covers: the two ticks on order (refused before Stripe) / generate / redo /
// upload / launch, the audit row (IP, user agent, snapshot), the append-only
// trigger (and the one UPDATE account deletion may do), the terms gate,
// REVIEW wording -> launch 409 -> admin approve -> a new phrase re-flags,
// takedown (Google pause, relaunch / resume / generate / order refused, the
// report page), public reports (404, rate limit), requireAdmin's 403 stopping
// the handler, and India unaffected.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import Fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../db/schema.js";
import { ATTESTATION_VERSION, TERMS_VERSION, attestationSnapshotText } from "../lib/compliance/texts.js";

const ATTEST = { accuracy: true, media: true, version: ATTESTATION_VERSION };

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
  };
  for (const [k, v] of Object.entries(dummy)) process.env[k] ??= v;
  delete process.env.OWN_VIDEO_UPLOADS;
  return {
    db: null as unknown,
    checkouts: [] as unknown[],
    pauses: [] as string[],
    enables: [] as string[],
    alerts: [] as { title: string }[],
  };
});

vi.mock("../db/index.js", () => ({
  get db() {
    return holder.db;
  },
}));
vi.mock("../lib/googleAds/env.js", async (orig) => ({ ...(await orig<object>()), isGoogleAdsConfigured: () => true }));
vi.mock("../lib/googleAds/mcc.js", async (orig) => ({
  ...(await orig<object>()),
  isMccConfigured: () => true,
  mccAccessToken: async () => "token",
  pauseCampaign: async (a: { campaignResourceName: string }) => {
    holder.pauses.push(a.campaignResourceName);
  },
  enableCampaign: async (a: { campaignResourceName: string }) => {
    holder.enables.push(a.campaignResourceName);
  },
}));
vi.mock("../lib/payments/index.js", async (orig) => ({
  ...(await orig<object>()),
  providerFor: () => ({
    name: "stripe",
    isConfigured: () => true,
    createCheckout: async (req: unknown) => {
      holder.checkouts.push(req);
      return { providerRef: "cs_test", redirectUrl: "https://checkout.invalid" };
    },
  }),
}));
vi.mock("../lib/billing/managedCard.js", async (orig) => ({
  ...(await orig<object>()),
  syncCardLimit: async () => undefined,
  unfreezeCardsForUser: async () => undefined,
}));
vi.mock("../lib/planBilling/index.js", async (orig) => ({
  ...(await orig<object>()),
  syncPlanBillingForUser: async () => undefined,
  endStripePlansNow: async () => undefined,
  planAllowsRunningFor: async () => true,
}));
vi.mock("../lib/ai/script/index.js", () => ({
  generateScript: async () => ({ script: { hook: "Hook", body: "Body", voiceoverText: "Voice", scenes: [] }, source: "fallback" }),
}));
vi.mock("../render/jobs.js", () => ({ enqueueRender: async () => undefined }));
vi.mock("../plugins/r2.js", async (orig) => ({
  ...(await orig<object>()),
  headObject: async () => ({ sizeBytes: 1000, contentType: "video/mp4" }),
  presignUpload: async (key: string) => `https://r2.invalid/${key}`,
  presignDownload: async (key: string) => `https://r2.invalid/${key}`,
  deleteObject: async () => undefined,
}));
vi.mock("../lib/ops/notify.js", () => ({
  isOpsNotifyConfigured: () => true,
  notifyOps: async (a: { title: string }) => {
    holder.alerts.push(a);
    return true;
  },
}));

let app: FastifyInstance;
let pg: PGlite;
let sign: (p: { sub: string; role: "admin" | "advertiser" }) => string;
let admin: string;
let shop: string;

async function newUser(email: string, role: "admin" | "advertiser", country = "US"): Promise<string> {
  const r = await pg.query<{ id: string }>(
    `insert into users (email, password_hash, role, country_code, currency_code) values ($1, 'x', $2, $3, $4) returning id`,
    [email, role, country, country === "IN" ? "INR" : "USD"],
  );
  return r.rows[0]!.id;
}
const acceptTerms = (userId: string) =>
  pg.query(`insert into terms_acceptances (user_id, version) values ($1, $2)`, [userId, TERMS_VERSION]);

async function campaignFor(userId: string, extra: { offer?: string; currency?: string } = {}): Promise<string> {
  const r = await pg.query<{ id: string }>(
    `insert into campaigns (user_id, name, business_name, business_category, target_zip_codes, daily_budget_cents, landing_url, offer_details, currency_code)
     values ($1, 'Spring', 'Lawn Pros', 'landscaping', '{08817}', 1000, 'https://lawn.example', $2, $3) returning id`,
    [userId, extra.offer ?? "$49 mowing this month.", extra.currency ?? "USD"],
  );
  return r.rows[0]!.id;
}
async function photo(userId: string): Promise<string> {
  const r = await pg.query<{ id: string }>(
    `insert into assets (user_id, kind, r2_key, content_type) values ($1, 'photo', $2, 'image/jpeg') returning id`,
    [userId, `users/${userId}/${Math.random().toString(36).slice(2)}.jpg`],
  );
  return r.rows[0]!.id;
}
const attestations = async (campaignId: string) =>
  (await pg.query<Record<string, unknown>>(`select * from ad_attestations where campaign_id = $1 order by created_at`, [campaignId])).rows;

const token = (userId: string) => sign({ sub: userId, role: userId === admin ? "admin" : "advertiser" });
const call = (method: "GET" | "POST" | "PATCH" | "PUT", url: string, userId: string | null, payload?: unknown) =>
  app.inject({
    method,
    url,
    headers: {
      ...(userId ? { authorization: `Bearer ${token(userId)}` } : {}),
      "cf-connecting-ip": "203.0.113.7",
      "user-agent": "vitest-agent/1.0",
    },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });

let adminHandlerRan = false;

beforeAll(async () => {
  pg = new PGlite();
  const dir = join(__dirname, "../../drizzle");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    await pg.exec(readFileSync(join(dir, f), "utf8").replaceAll("--> statement-breakpoint", ""));
  }
  holder.db = drizzle(pg, { schema });
  admin = await newUser("admin@x.test", "admin");
  shop = await newUser("shop@x.test", "advertiser");

  sign = (await import("../auth/jwt.js")).signAccessToken;
  const { authPlugin, requireAdmin } = await import("../auth/plugin.js");
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(authPlugin);
  for (const [mod, name] of [
    ["./auth.js", "authRoutes"],
    ["./campaigns.js", "campaignRoutes"],
    ["./campaignOffer.js", "campaignOfferRoutes"],
    ["./creatives.js", "creativeRoutes"],
    ["./newAds.js", "newAdRoutes"],
    ["./uploads.js", "uploadRoutes"],
    ["./launch.js", "launchRoutes"],
    ["./campaignRunState.js", "campaignRunStateRoutes"],
    ["./reports.js", "reportRoutes"],
  ] as const) {
    await app.register((await import(mod))[name]);
  }
  // A bare requireAdmin route: proves the 403 STOPS the handler.
  app.get("/__admin-probe", { preHandler: requireAdmin }, async () => {
    adminHandlerRan = true;
    return { ran: true };
  });
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
});

beforeEach(() => {
  holder.checkouts.length = 0;
  holder.pauses.length = 0;
  holder.enables.length = 0;
  holder.alerts.length = 0;
});

describe("requireAdmin", () => {
  it("a non-admin gets 403 and the handler never runs", async () => {
    adminHandlerRan = false;
    const res = await call("GET", "/__admin-probe", shop);
    expect(res.statusCode).toBe(403);
    expect(adminHandlerRan).toBe(false);
    expect((await call("GET", "/__admin-probe", admin)).statusCode).toBe(200);
    expect(adminHandlerRan).toBe(true);
  });

  it("admin compliance routes refuse customers and a JWT admin whose DB role is gone", async () => {
    expect((await call("GET", "/admin/reports", shop)).statusCode).toBe(403);
    const demoted = await newUser("demoted@x.test", "advertiser");
    const res = await app.inject({
      method: "GET",
      url: "/admin/compliance",
      headers: { authorization: `Bearer ${sign({ sub: demoted, role: "admin" })}` },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("terms of service", () => {
  it("/auth/me says not accepted; POST /auth/me/terms records the current version with IP and UA", async () => {
    const u = await newUser("terms@x.test", "advertiser");
    expect((await call("GET", "/auth/me", u)).json().terms).toEqual({ accepted: null, current: TERMS_VERSION, ok: false });
    expect((await call("POST", "/auth/me/terms", u, { version: "1999-01-01" })).statusCode).toBe(409);
    const ok = await call("POST", "/auth/me/terms", u, { version: TERMS_VERSION });
    expect(ok.statusCode).toBe(200);
    expect((await call("GET", "/auth/me", u)).json().terms.ok).toBe(true);
    const rows = (await pg.query(`select * from terms_acceptances where user_id = $1`, [u])).rows;
    expect(rows).toEqual([expect.objectContaining({ version: TERMS_VERSION, ip_address: "203.0.113.7", user_agent: "vitest-agent/1.0" })]);
  });

  it("signup with the checkbox records acceptance", async () => {
    const res = await call("POST", "/auth/register", null, { email: "new@x.test", password: "x".repeat(12), termsVersion: TERMS_VERSION });
    expect(res.statusCode).toBe(201);
    const { rows } = await pg.query(`select t.version from terms_acceptances t join users u on u.id = t.user_id where u.email = 'new@x.test'`);
    expect(rows).toEqual([{ version: TERMS_VERSION }]);
  });

  it("order, generate and launch refuse 409 terms_not_accepted (admins too)", async () => {
    const u = await newUser("noterms@x.test", "advertiser");
    const c = await campaignFor(u);
    const p = await photo(u);
    for (const [url, body] of [
      [`/campaigns/${c}/new-ad/order`, { assetIds: [p], attestation: ATTEST }],
      [`/campaigns/${c}/creatives/generate`, { assetIds: [p], attestation: ATTEST }],
      [`/campaigns/${c}/launch`, { adAccountId: "00000000-0000-4000-8000-000000000000", validateOnly: true, attestation: ATTEST }],
    ] as const) {
      const res = await call("POST", url, u, body);
      expect(res.statusCode, url).toBe(409);
      expect(res.json().error).toBe("terms_not_accepted");
    }
    const a = await newUser("admin-noterms@x.test", "admin");
    const ac = await campaignFor(a);
    const res = await app.inject({
      method: "POST",
      url: `/campaigns/${ac}/creatives/generate`,
      headers: { authorization: `Bearer ${sign({ sub: a, role: "admin" })}` },
      payload: { assetIds: [await photo(a)], attestation: ATTEST },
    });
    expect(res.json().error).toBe("terms_not_accepted");
    expect(holder.checkouts).toEqual([]);
  });
});

describe("attestation", () => {
  beforeAll(async () => {
    await acceptTerms(shop);
    await acceptTerms(admin);
  });

  it("new-ad order without both ticks is 400 attestation_required, before Stripe and before any purchase", async () => {
    const c = await campaignFor(shop);
    const p = await photo(shop);
    for (const attestation of [undefined, { accuracy: true }, { ...ATTEST, media: false }, { ...ATTEST, version: "old" }]) {
      const res = await call("POST", `/campaigns/${c}/new-ad/order`, shop, { assetIds: [p], attestation });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("attestation_required");
    }
    expect(holder.checkouts).toEqual([]);
    expect((await pg.query(`select 1 from purchases where campaign_id = $1`, [c])).rows).toHaveLength(0);
    expect(await attestations(c)).toHaveLength(0);
  });

  it("with both ticks the order goes to checkout and the audit row has the text, IP, UA, snapshot and purchase", async () => {
    const c = await campaignFor(shop);
    const p = await photo(shop);
    const res = await call("POST", `/campaigns/${c}/new-ad/order`, shop, { assetIds: [p], attestation: ATTEST });
    expect(res.statusCode).toBe(201);
    expect(holder.checkouts).toHaveLength(1);
    const [row] = await attestations(c);
    expect(row).toMatchObject({
      action: "order",
      user_id: shop,
      purchase_id: res.json().purchaseId,
      attestation_text_version: ATTESTATION_VERSION,
      exact_text_snapshot: attestationSnapshotText(),
      ip_address: "203.0.113.7",
      user_agent: "vitest-agent/1.0",
    });
    const snap = row!.content_snapshot as { campaign: { offerDetails: string; businessName: string }; assetKeys: string[] };
    expect(snap.campaign).toMatchObject({ offerDetails: "$49 mowing this month.", businessName: "Lawn Pros" });
    expect(snap.assetKeys).toHaveLength(1);
  });

  it("generate and redo refuse without the ticks (admins too); with them they reach the paid-ad gate", async () => {
    for (const user of [shop, admin]) {
      const c = await campaignFor(user);
      const p = await photo(user);
      const gen = await call("POST", `/campaigns/${c}/creatives/generate`, user, { assetIds: [p] });
      expect(gen.statusCode).toBe(400);
      expect(gen.json().error).toBe("attestation_required");
      const redo = await call("POST", `/campaigns/${c}/creatives/redo`, user, {});
      expect(redo.statusCode).toBe(400);
      expect(redo.json().error).toBe("attestation_required");
    }
    const c = await campaignFor(shop);
    const ok = await call("POST", `/campaigns/${c}/creatives/generate`, shop, { assetIds: [await photo(shop)], attestation: ATTEST });
    expect(ok.statusCode).toBe(402);
  });

  it("an admin's generate with the ticks is recorded with the generated creative and its writer input", async () => {
    const c = await campaignFor(admin);
    const p = await photo(admin);
    const res = await call("POST", `/campaigns/${c}/creatives/generate`, admin, { assetIds: [p], attestation: ATTEST, aspectRatios: ["9:16"] });
    expect(res.statusCode).toBe(202);
    const [row] = await attestations(c);
    expect(row).toMatchObject({ action: "generate", creative_id: res.json().creatives[0].id });
    const { rows } = await pg.query<{ generation_inputs: Record<string, unknown> }>(`select generation_inputs from creatives where campaign_id = $1`, [c]);
    expect(rows[0]!.generation_inputs).toMatchObject({ businessName: "Lawn Pros", offerDetails: "$49 mowing this month." });
    expect(rows[0]!.generation_inputs.promptVersion).toBeTruthy();
    expect(JSON.stringify(rows[0]!.generation_inputs)).not.toContain("https://");
  });

  it("upload confirm refuses without the ticks (admin too) and records one with them", async () => {
    const c = await campaignFor(admin);
    const meta = { width: 1080, height: 1920, durationSeconds: 20, creativeId: "11111111-1111-4111-8111-111111111111", rightsAttested: true };
    const bad = await call("POST", `/campaigns/${c}/creatives/upload`, admin, meta);
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe("attestation_required");
    const ok = await call("POST", `/campaigns/${c}/creatives/upload`, admin, { ...meta, attestation: ATTEST });
    expect(ok.statusCode).toBe(201);
    expect(await attestations(c)).toEqual([expect.objectContaining({ action: "upload", creative_id: meta.creativeId })]);
  });

  it("launch (dry run included) refuses without the ticks and records a press with them", async () => {
    const c = await campaignFor(shop);
    const body = { adAccountId: "00000000-0000-4000-8000-000000000000", validateOnly: true };
    const bad = await call("POST", `/campaigns/${c}/launch`, shop, body);
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe("attestation_required");
    const ok = await call("POST", `/campaigns/${c}/launch`, shop, { ...body, attestation: ATTEST });
    expect(["attestation_required", "terms_not_accepted", "needs_review", "ad_taken_down"]).not.toContain(ok.json().error);
    expect(await attestations(c)).toEqual([expect.objectContaining({ action: "launch" })]);
  });

  it("India: the same ticks work for an INR account", async () => {
    // An India admin account (admins skip the paid-ad gate, not the ticks).
    const u = await newUser("delhi@x.test", "admin", "IN");
    await acceptTerms(u);
    const c = await campaignFor(u, { currency: "INR" });
    const gen = (body: object) =>
      app.inject({
        method: "POST",
        url: `/campaigns/${c}/creatives/generate`,
        headers: { authorization: `Bearer ${sign({ sub: u, role: "admin" })}` },
        payload: body,
      });
    expect((await gen({ assetIds: [await photo(u)] })).json().error).toBe("attestation_required");
    const res = await gen({ assetIds: [await photo(u)], attestation: ATTEST, aspectRatios: ["9:16"] });
    expect(res.statusCode).toBe(202);
    expect((await attestations(c))[0]).toMatchObject({ action: "generate", exact_text_snapshot: attestationSnapshotText() });
  });
});

describe("ad_attestations / terms_acceptances are append-only", () => {
  it("UPDATE, DELETE and TRUNCATE fail; only blanking ip/user agent is allowed", async () => {
    const c = await campaignFor(shop);
    await pg.query(
      `insert into ad_attestations (campaign_id, user_id, action, attestation_text_version, exact_text_snapshot, ip_address, user_agent)
       values ($1, $2, 'launch', 'v', 't', '1.2.3.4', 'ua')`,
      [c, shop],
    );
    await expect(pg.query(`update ad_attestations set exact_text_snapshot = 'x' where campaign_id = $1`, [c])).rejects.toThrow(/append-only/);
    await expect(pg.query(`update ad_attestations set ip_address = '9.9.9.9' where campaign_id = $1`, [c])).rejects.toThrow(/append-only/);
    await expect(pg.query(`update ad_attestations set ip_address = null, action = 'order' where campaign_id = $1`, [c])).rejects.toThrow(
      /append-only/,
    );
    await expect(pg.query(`delete from ad_attestations where campaign_id = $1`, [c])).rejects.toThrow(/append-only/);
    await expect(pg.query(`truncate ad_attestations`)).rejects.toThrow(/append-only/);
    await expect(pg.query(`delete from terms_acceptances where user_id = $1`, [shop])).rejects.toThrow(/append-only/);
    await pg.query(`update ad_attestations set ip_address = null, user_agent = null where campaign_id = $1`, [c]);
    expect((await attestations(c))[0]).toMatchObject({ ip_address: null, user_agent: null, exact_text_snapshot: "t" });
  });

  it("account deletion keeps the rows and blanks their IP and user agent; deleting the campaign keeps them too", async () => {
    const u = await newUser("leaving@x.test", "advertiser");
    await call("POST", "/auth/me/terms", u, { version: TERMS_VERSION });
    const c = await campaignFor(u);
    await call("POST", `/campaigns/${c}/new-ad/order`, u, { assetIds: [await photo(u)], attestation: ATTEST });
    expect(await attestations(c)).toHaveLength(1);
    const { deleteAccount } = await import("../lib/accountDeletion.js");
    expect(await deleteAccount(u)).toEqual({ ok: true });
    expect(await attestations(c)).toEqual([expect.objectContaining({ user_id: u, ip_address: null, user_agent: null })]);
    const terms = (await pg.query(`select ip_address, user_agent from terms_acceptances where user_id = $1`, [u])).rows;
    expect(terms).toEqual([{ ip_address: null, user_agent: null }]);
    await pg.query(`delete from purchases where campaign_id = $1`, [c]);
    await pg.query(`delete from campaigns where id = $1`, [c]);
    expect(await attestations(c)).toHaveLength(1);
  });
});

describe("REVIEW wording", () => {
  beforeAll(async () => {
    await acceptTerms(shop);
  });

  it("flags on create, launch answers 409 needs_review, an admin approves, a NEW phrase flags again", async () => {
    const create = await call("POST", "/campaigns", shop, {
      name: "Fix",
      businessName: "Back Clinic",
      businessCategory: "Chiropractic",
      callToAction: "Call now",
      landingUrl: "https://clinic.example",
      offerDetails: "Our therapy cures back pain for good.",
      targetZipCodes: ["08817"],
      radiusMiles: 10,
      dailyBudgetCents: 500,
    });
    expect(create.statusCode).toBe(201);
    const c = create.json();
    expect(c.complianceStatus).toBe("needs_review");
    expect(c.complianceReasons[0]).toMatchObject({ id: "review_health_cure", field: "offer" });
    expect(c.publicId).toMatch(/^[0-9a-f]{32}$/);

    const launch = await call("POST", `/campaigns/${c.id}/launch`, shop, {
      adAccountId: "00000000-0000-4000-8000-000000000000",
      validateOnly: true,
      attestation: ATTEST,
    });
    expect(launch.statusCode).toBe(409);
    expect(launch.json()).toMatchObject({ error: "needs_review", reasons: [expect.objectContaining({ phrase: "cures" })] });

    const queue = (await call("GET", "/admin/compliance", admin)).json();
    expect(queue.needsReview.map((r: { campaignId: string }) => r.campaignId)).toContain(c.id);
    const approved = await call("POST", `/admin/compliance/${c.id}/approve`, admin);
    expect(approved.statusCode).toBe(200);
    expect(approved.json().complianceStatus).toBe("ok");

    const again = await call("POST", `/campaigns/${c.id}/launch`, shop, {
      adAccountId: "00000000-0000-4000-8000-000000000000",
      validateOnly: true,
      attestation: ATTEST,
    });
    expect(again.json().error).not.toBe("needs_review");

    // Same wording saved again: still approved.
    const same = await call("PUT", `/campaigns/${c.id}/offer`, shop, { offerDetails: "Our therapy cures back pain for good." });
    expect(same.json().campaign.complianceStatus).toBe("ok");
    // A new review phrase: back to needs_review.
    const edited = await call("PATCH", `/campaigns/${c.id}`, shop, { offerDetails: "Our therapy cures back pain. Bitcoin accepted." });
    expect(edited.json().complianceStatus).toBe("needs_review");
    // Warn-only wording never flags.
    const plain = await call("PATCH", `/campaigns/${c.id}`, shop, { offerDetails: "The best adjustments in town." });
    expect(plain.json().complianceStatus).toBe("ok");
  });
});

describe("reports and takedown", () => {
  beforeAll(async () => {
    await acceptTerms(shop);
  });

  async function liveCampaign() {
    const c = await campaignFor(shop);
    const customer = String(Math.floor(Math.random() * 1e10)).padStart(10, "1");
    const a = await pg.query<{ id: string }>(
      `insert into ad_accounts (user_id, provider, customer_id, currency_code, is_managed, billing_mode, billing_link_status,
         login_customer_id, manager_customer_id, status, provision_status)
       values ($1, 'google_ads', $2, 'USD', true, 'platform', 'active', '999', '999', 'active', 'active') returning id`,
      [shop, customer],
    );
    await pg.query(
      `update campaigns set status = 'live', ad_account_id = $2, google_customer_id = $3,
         google_campaign_resource_name = 'customers/' || $3 || '/campaigns/1' where id = $1`,
      [c, a.rows[0]!.id, customer],
    );
    const { rows } = await pg.query<{ public_id: string }>(`select public_id from campaigns where id = $1`, [c]);
    return { id: c, publicId: rows[0]!.public_id };
  }

  it("public report: unknown id 404, filed report pings ops, then rate-limited per IP", async () => {
    expect((await call("GET", "/reports/ad/doesnotexist00", null)).statusCode).toBe(404);
    const { publicId } = await liveCampaign();
    expect((await call("GET", `/reports/ad/${publicId}`, null)).json()).toMatchObject({ status: "active" });
    const res = await call("POST", "/reports", null, { ad: publicId, reason: "scam_or_fraud", details: "Fake", email: "" });
    expect(res.statusCode).toBe(201);
    expect(holder.alerts.some((a) => a.title.includes("reported"))).toBe(true);
    expect((await call("POST", "/reports", null, { ad: "doesnotexist00", reason: "other" })).statusCode).toBe(404);
    let last = 0;
    for (let i = 0; i < 6; i++) last = (await call("POST", "/reports", null, { ad: publicId, reason: "other" })).statusCode;
    expect(last).toBe(429);
  });

  it("take down: pauses at Google, refuses relaunch / resume / generate / order, report page says removed", async () => {
    const { id, publicId } = await liveCampaign();
    const report = await pg.query<{ id: string }>(
      `insert into ad_reports (campaign_id, reason, ip_address) values ($1, 'offensive', '198.51.100.1') returning id`,
      [id],
    );
    expect((await call("GET", "/admin/reports", admin)).json().reports.map((r: { id: string }) => r.id)).toContain(report.rows[0]!.id);

    const res = await call("POST", `/admin/campaigns/${id}/takedown`, admin, { reason: "Misleading health claim" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ takenDown: true, google: "paused" });
    expect(holder.pauses).toHaveLength(1);
    const { rows } = await pg.query(`select status, compliance_status, taken_down_by from campaigns where id = $1`, [id]);
    expect(rows[0]).toEqual({ status: "paused", compliance_status: "taken_down", taken_down_by: admin });
    expect((await pg.query(`select status from ad_reports where id = $1`, [report.rows[0]!.id])).rows[0]).toEqual({ status: "actioned" });

    const p = await photo(shop);
    for (const [url, body] of [
      [`/campaigns/${id}/resume`, {}],
      [`/campaigns/${id}/launch`, { adAccountId: "00000000-0000-4000-8000-000000000000", validateOnly: true, attestation: ATTEST }],
      [`/campaigns/${id}/creatives/generate`, { assetIds: [p], attestation: ATTEST }],
      [`/campaigns/${id}/creatives/redo`, { attestation: ATTEST }],
      [`/campaigns/${id}/new-ad/order`, { assetIds: [p], attestation: ATTEST }],
    ] as const) {
      const r = await call("POST", url, shop, body);
      expect(r.statusCode, url).toBe(409);
      expect(r.json().error, url).toBe("ad_taken_down");
    }
    expect(holder.enables).toEqual([]);
    expect(holder.checkouts).toEqual([]);

    expect((await call("GET", `/reports/ad/${publicId}`, null)).json()).toEqual({ status: "removed" });
    await pg.query(`delete from ad_reports where ip_address = '203.0.113.7'`); // the rate limit above
    expect((await call("POST", "/reports", null, { ad: publicId, reason: "other" })).statusCode).toBe(409);
    expect((await call("POST", `/admin/campaigns/${id}/takedown`, admin, { reason: "again" })).statusCode).toBe(409);
  });

  it("the top-up / plan resume never switches a taken-down ad back on", async () => {
    const { id } = await liveCampaign();
    await call("POST", `/admin/campaigns/${id}/takedown`, admin, { reason: "Scam" });
    // As if funds ran out before the takedown.
    await pg.query(`update campaigns set paused_for_funds_at = now() where id = $1`, [id]);
    await pg.query(`insert into wallets (user_id, currency_code, balance_minor) values ($1, 'USD', 1000000) on conflict do nothing`, [shop]);
    const { resumeFundedCampaigns } = await import("../lib/billing/resume.js");
    await resumeFundedCampaigns(shop);
    expect(holder.enables).toEqual([]);
    expect((await pg.query(`select status from campaigns where id = $1`, [id])).rows[0]).toEqual({ status: "paused" });
  });

  it("dismiss closes an open report", async () => {
    const { id } = await liveCampaign();
    const r = await pg.query<{ id: string }>(`insert into ad_reports (campaign_id, reason) values ($1, 'other') returning id`, [id]);
    expect((await call("POST", `/admin/reports/${r.rows[0]!.id}/dismiss`, admin)).statusCode).toBe(200);
    expect((await call("POST", `/admin/reports/${r.rows[0]!.id}/dismiss`, admin)).statusCode).toBe(409);
  });
});

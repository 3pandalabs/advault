// "Change my offer" end to end on PGlite (every drizzle/*.sql applied): the
// routes, the price (one included a month, then $2), the compliance gate, the
// $2 payment, and the swap sweep with Google STUBBED (approve-then-remove,
// disapproval keeps the old ad, the end date returns to the base ad). R2,
// ntfy and the model are stubbed; WhatsApp is unconfigured (inert).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../db/schema.js";

const holder = vi.hoisted(() => {
  const dummy: Record<string, string> = {
    DATABASE_URL: "postgres://unused@localhost/unused",
    JWT_SECRET: "test-jwt-secret-test-jwt-secret-0000",
    TOKEN_ENCRYPTION_KEY: "0".repeat(64),
    R2_ACCOUNT_ID: "test",
    R2_ACCESS_KEY_ID: "test",
    R2_SECRET_ACCESS_KEY: "test",
    R2_BUCKET: "test",
    R2_ENDPOINT: "https://r2.invalid",
  };
  for (const [k, v] of Object.entries(dummy)) process.env[k] ??= v;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.WHATSAPP_TOKEN;
  return { db: null as unknown, alerts: [] as { title: string; message: string }[] };
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
vi.mock("../plugins/r2.js", () => ({
  presignDownload: async (k: string) => `https://r2.test/${k}`,
  putObject: async () => undefined,
  deleteObject: async () => undefined,
  headObject: async () => null,
  getObjectBytes: async () => Buffer.from(""),
  assetKey: (u: string, ext: string) => `assets/${u}/${Math.random().toString(36).slice(2)}.${ext}`,
}));
vi.mock("../lib/ops/notify.js", () => ({
  notifyOps: async (a: { title: string; message: string }) => {
    holder.alerts.push(a);
    return true;
  },
  isOpsNotifyConfigured: () => true,
}));

const MIGRATIONS = join(__dirname, "../../drizzle");
let app: FastifyInstance;
let pg: PGlite;
let ATTEST: Record<string, unknown>;

const AD = "customers/123/adGroupAds/9~1";
const SCRIPT = {
  hook: "Spotless homes, 20% off this month",
  scenes: [
    { assetIndex: 0, caption: "20% off deep cleans", durationSeconds: 4 },
    { assetIndex: 1, caption: "Sparkle Cleaning", durationSeconds: 4 },
  ],
  callToAction: "Book now",
  endCardText: "Sparkle Cleaning",
  voiceoverText: "[cheerfully] Twenty percent off deep cleans at Sparkle Cleaning. Book now.",
  sticker: { badge: "20% OFF", headline: "DEEP CLEANS", tagline: "THIS MONTH ONLY", benefits: [] },
  photoMotions: [{ assetIndex: 0, motion: "the cleaner wipes the counter" }],
  openerPrompt: "Morning light across a spotless kitchen counter, slow dolly-in over gleaming tiles",
};

beforeAll(async () => {
  pg = new PGlite();
  for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith(".sql")).sort()) {
    await pg.exec(readFileSync(join(MIGRATIONS, f), "utf8").replaceAll("--> statement-breakpoint", ""));
  }
  // 0047 is idempotent: a second run changes nothing and does not throw.
  await pg.exec(readFileSync(join(MIGRATIONS, "0047_offer_changes.sql"), "utf8"));
  holder.db = drizzle(pg, { schema });
  const { ATTESTATION_VERSION } = await import("../lib/compliance/texts.js");
  ATTEST = { accuracy: true, media: true, version: ATTESTATION_VERSION };
  const { offerChangeRoutes } = await import("./offerChanges.js");
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(offerChangeRoutes);
  await app.ready();
}, 90_000);

afterAll(async () => {
  await app?.close();
});

beforeEach(() => {
  holder.alerts.length = 0;
});

async function user(opts: { role?: string; plan?: "evergreen" | null; category?: string } = {}) {
  const { TERMS_VERSION } = await import("../lib/compliance/texts.js");
  const id = (
    await pg.query<{ id: string }>(`insert into users (email, password_hash, role) values ($1, 'x', $2) returning id`, [
      `${Math.random().toString(36).slice(2)}@x.test`,
      opts.role ?? "advertiser",
    ])
  ).rows[0]!.id;
  await pg.query(`insert into terms_acceptances (user_id, version) values ($1, $2)`, [id, TERMS_VERSION]);
  if (opts.plan === "evergreen") {
    await pg.query(
      `insert into subscriptions (user_id, plan_key, line, currency_code, amount_minor, provider, status) values ($1, 'us-evergreen', 'evergreen', 'USD', 2000, 'stripe', 'active')`,
      [id],
    );
  }
  const acct = (
    await pg.query<{ id: string }>(
      `insert into ad_accounts (user_id, provider, customer_id, currency_code, is_managed, billing_mode, billing_link_status, login_customer_id, manager_customer_id, status, provision_status)
       values ($1, 'google_ads', '1234567890', 'USD', true, 'platform', 'active', '999', '999', 'active', 'active') returning id`,
      [id],
    )
  ).rows[0]!.id;
  const campaign = (
    await pg.query<{ id: string }>(
      `insert into campaigns (user_id, ad_account_id, name, business_name, business_category, target_zip_codes, daily_budget_cents, status,
         google_campaign_resource_name, google_ad_group_resource_name, google_customer_id, launched_at, offer_details, call_to_action)
       values ($1, $2, 'Fall', 'Sparkle Cleaning', $3, '{08817}', 500, 'live', 'customers/123/campaigns/5', 'customers/123/adGroups/9', '123', now(), '20% off deep cleans', 'Book now') returning id`,
      [id, acct, opts.category ?? "Cleaning"],
    )
  ).rows[0]!.id;
  for (const aspect of ["16:9", "9:16"]) {
    await pg.query(
      `insert into creatives (campaign_id, aspect_ratio, script, script_source, source_asset_keys, render_status, video_key, youtube_video_id, youtube_upload_status, google_ad_resource_name, generation_inputs)
       values ($1, $2, $3, 'ai', '{assets/a.jpg,assets/b.jpg}', 'ready', 'v.mp4', $4, 'done', $5, $6)`,
      [campaign, aspect, JSON.stringify(SCRIPT), aspect === "16:9" ? "launch16x9aa" : "launch9x16aa", AD, JSON.stringify({ offerDetails: "20% off deep cleans" })],
    );
  }
  return { id, campaign };
}

const post = (url: string, userId: string, payload?: object) =>
  app.inject({ method: "POST", url, headers: { "x-test-user": userId }, ...(payload ? { payload } : {}) });
const get = (url: string, userId: string) => app.inject({ method: "GET", url, headers: { "x-test-user": userId } });

async function makePreview(u: { id: string; campaign: string }, offerText = "$25 off any move-out clean until Dec 15") {
  const res = await post(`/campaigns/${u.campaign}/offer-changes`, u.id, { offerText, attestation: ATTEST });
  expect(res.statusCode, res.body).toBe(201);
  const changeId = res.json().change.id as string;
  // The renderer finished the cuts.
  await pg.query(`update creatives set render_status = 'ready', video_key = 'cut.mp4', thumbnail_key = 'cut.jpg' where offer_change_id = $1`, [changeId]);
  return changeId;
}

/** A Google stand-in: ads by resource name with a status and a verdict. */
function fakeGoogle() {
  const ads = new Map<string, { status: string; policy: string }>([[AD, { status: "ENABLED", policy: "approved" }]]);
  let n = 100;
  const calls: { op: string; arg: unknown }[] = [];
  const port = {
    ctxFor: async () => ({ accessToken: "t", customerId: "123", loginCustomerId: "999" }),
    readAd: async (_ctx: unknown, rn: string) => {
      const a = ads.get(rn);
      return a
        ? { resourceName: rn, status: a.status, finalUrl: "https://sparkle.test/?utm_source=youtube", logoAsset: "customers/123/assets/7", policy: a.policy as never, topics: a.policy === "disapproved" ? ["MISLEADING"] : [] }
        : null;
    },
    addAd: async (_ctx: unknown, plan: { status: string }) => {
      const rn = `customers/123/adGroupAds/9~${n++}`;
      ads.set(rn, { status: plan.status, policy: "under_review" });
      calls.push({ op: "add", arg: plan });
      return rn;
    },
    changeAdStatuses: async (_ctx: unknown, ch: { enable?: string[]; pause?: string[]; remove?: string[] }) => {
      calls.push({ op: "status", arg: ch });
      for (const r of ch.enable ?? []) if (ads.get(r)) ads.get(r)!.status = "ENABLED";
      for (const r of ch.pause ?? []) if (ads.get(r)) ads.get(r)!.status = "PAUSED";
      for (const r of ch.remove ?? []) if (ads.get(r)) ads.get(r)!.status = "REMOVED";
    },
    findVideoAsset: async () => null,
  };
  return { ads, calls, port };
}

async function sweep(port: unknown, now = new Date()) {
  const { runOfferSwapSweep } = await import("../lib/offerSwap/sweep.js");
  return runOfferSwapSweep({ now, google: port as never });
}

const statusOf = async (id: string) => (await pg.query<{ status: string }>(`select status from offer_changes where id = $1`, [id])).rows[0]!.status;

describe("making a preview", () => {
  it("re-cuts both shapes in reuse-only mode, keeps the photos and motion, never uploads", async () => {
    const u = await user({ plan: "evergreen" });
    const res = await post(`/campaigns/${u.campaign}/offer-changes`, u.id, { offerText: "$25 off any move-out clean until Dec 15", attestation: ATTEST });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json();
    expect(body.change.stage).toBe("making");
    expect(body.quote).toMatchObject({ charge: "included", amountMinor: 0 });
    const cuts = await pg.query<{ script: typeof SCRIPT; render_info: { recut: { allowMotionKeys: string[] } }; source_asset_keys: string[]; youtube_video_id: string | null; google_ad_resource_name: string | null }>(
      `select script, render_info, source_asset_keys, youtube_video_id, google_ad_resource_name from creatives where offer_change_id = $1`,
      [body.change.id],
    );
    expect(cuts.rows).toHaveLength(2);
    for (const c of cuts.rows) {
      expect(c.source_asset_keys).toEqual(["assets/a.jpg", "assets/b.jpg"]);
      expect(c.script.photoMotions).toEqual(SCRIPT.photoMotions);
      expect(c.script.openerPrompt).toBe(SCRIPT.openerPrompt);
      expect(c.script.sticker.badge).toBe("$25 OFF");
      expect(c.render_info.recut.allowMotionKeys).toEqual([]);
      expect(c.youtube_video_id).toBeNull();
      expect(c.google_ad_resource_name).toBeNull();
    }
    // One voiceover for both shapes (one TTS call).
    expect(cuts.rows[0]!.script.voiceoverText).toBe(cuts.rows[1]!.script.voiceoverText);
    // The launch ad had an offer: a no-offer BASE cut is queued once.
    const base = await pg.query<{ n: number }>(`select count(*)::int n from offer_changes where campaign_id = $1 and kind = 'base'`, [u.campaign]);
    expect(base.rows[0]!.n).toBe(1);
    // Nothing published: no YouTube job for the preview.
    const yt = await pg.query<{ n: number }>(`select count(*)::int n from youtube_upload_jobs j join creatives c on c.id = j.creative_id where c.offer_change_id = $1`, [body.change.id]);
    expect(yt.rows[0]!.n).toBe(0);
  });

  it("needs the two ticks and accepted terms; refuses a housing exclusion; refuses a campaign that never launched", async () => {
    const u = await user({ plan: "evergreen", category: "Real estate" });
    expect((await post(`/campaigns/${u.campaign}/offer-changes`, u.id, { offerText: "Open house Sunday" })).json().error).toBe("attestation_required");
    const blocked = await post(`/campaigns/${u.campaign}/offer-changes`, u.id, { offerText: "Adults only, open house Sunday", attestation: ATTEST });
    expect(blocked.statusCode).toBe(400);
    expect(blocked.json().error).toBe("claim_not_allowed");
    await pg.query(`update campaigns set google_campaign_resource_name = null, google_ad_group_resource_name = null where id = $1`, [u.campaign]);
    const notLaunched = await post(`/campaigns/${u.campaign}/offer-changes`, u.id, { offerText: "$10 off", attestation: ATTEST });
    expect(notLaunched.json().error).toBe("campaign_not_launched");
  });

  it("a newer preview supersedes the older one; another advertiser gets 404", async () => {
    const u = await user({ plan: "evergreen" });
    const first = await makePreview(u);
    const second = await makePreview(u, "$30 off until Dec 20");
    expect(await statusOf(first)).toBe("superseded");
    expect(await statusOf(second)).toBe("rendering");
    const other = await user();
    expect((await post(`/campaigns/${u.campaign}/offer-changes`, other.id, { offerText: "$1 off", attestation: ATTEST })).statusCode).toBe(404);
  });

  it("a REVIEW phrase holds 'Put it live' (needs_review) until an admin approves", async () => {
    const u = await user({ plan: "evergreen" });
    const id = await makePreview(u, "No credit check financing on every deep clean");
    await sweep(fakeGoogle().port);
    expect(await statusOf(id)).toBe("preview");
    const res = await post(`/offer-changes/${id}/confirm`, u.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("needs_review");
  });
});

describe("price: first change a month included, then $2", () => {
  it("included first, $2 checkout after, both on the plan; webhook publishes the paid one", async () => {
    const u = await user({ plan: "evergreen" });
    const g = fakeGoogle();
    const a = await makePreview(u);
    await sweep(g.port);
    const ok = await post(`/offer-changes/${a}/confirm`, u.id);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ status: "publishing", charge: "included" });
    // Publishing = YouTube jobs for the NEW creatives only.
    const yt = await pg.query<{ n: number }>(`select count(*)::int n from youtube_upload_jobs j join creatives c on c.id = j.creative_id where c.offer_change_id = $1`, [a]);
    expect(yt.rows[0]!.n).toBe(2);

    // Second change the same month (the first is live meanwhile).
    await pg.query(`update offer_changes set status = 'live' where id = $1`, [a]);
    const b = await makePreview(u, "$40 off until Dec 30");
    await sweep(g.port);
    const quote = (await get(`/campaigns/${u.campaign}/offer-changes`, u.id)).json().quote;
    expect(quote).toMatchObject({ charge: "paid", amountMinor: 200, display: "$2" });
    const paid = await post(`/offer-changes/${b}/confirm`, u.id);
    expect(paid.json()).toMatchObject({ status: "awaiting_payment", charge: "paid" });
    const purchaseId = paid.json().purchaseId as string;
    const p = await pg.query<{ sku: string; amount_minor: number }>(`select sku, amount_minor from purchases where id = $1`, [purchaseId]);
    expect(p.rows[0]).toEqual({ sku: "offer_change", amount_minor: 200 });

    const { markPurchasePaid } = await import("../lib/cinematic/index.js");
    const { onOfferChangePaid } = await import("../lib/offerSwap/index.js");
    await markPurchasePaid({ purchaseId, externalRef: `stripe:test-${purchaseId}` });
    expect(await onOfferChangePaid(purchaseId)).toBe(true);
    expect(await onOfferChangePaid(purchaseId)).toBe(false); // redelivery: nothing twice
    expect(await statusOf(b)).toBe("publishing");
  });

  it("two confirms racing for the one included change: only one gets it free", async () => {
    const u = await user({ plan: "evergreen" });
    const a = await makePreview(u);
    await sweep(fakeGoogle().port);
    await pg.query(`update offer_changes set status = 'live' where id = $1`, [a]); // leave the in-flight slot
    // Plant an earlier included change this month on another campaign of the same user.
    const { billingMonthOf } = await import("../lib/offerSwap/policy.js");
    await pg.query(`update offer_changes set charge = 'included', billing_month = $2 where id = $1`, [a, billingMonthOf(new Date())]);
    const b = await makePreview(u, "$45 off until Dec 30");
    await sweep(fakeGoogle().port);
    expect((await post(`/offer-changes/${b}/confirm`, u.id)).json().charge).toBe("paid");
  });

  it("no plan: $2 every time; admins: free", async () => {
    const u = await user({ plan: null });
    expect((await get(`/campaigns/${u.campaign}/offer-changes`, u.id)).json().quote).toMatchObject({ charge: "paid", amountMinor: 200 });
    const admin = await user({ role: "admin" });
    expect((await get(`/campaigns/${admin.campaign}/offer-changes`, admin.id)).json().quote).toMatchObject({ charge: "exempt", amountMinor: 0 });
  });

  it("cancelling a preview removes its cuts", async () => {
    const u = await user({ plan: "evergreen" });
    const a = await makePreview(u);
    expect((await post(`/offer-changes/${a}/cancel`, u.id)).statusCode).toBe(200);
    expect(await statusOf(a)).toBe("cancelled");
    const left = await pg.query<{ n: number }>(`select count(*)::int n from creatives where offer_change_id = $1`, [a]);
    expect(left.rows[0]!.n).toBe(0);
  });
});

describe("the swap at Google (stubbed)", () => {
  async function toPublished(u: { id: string; campaign: string }, g: ReturnType<typeof fakeGoogle>, offer?: string) {
    const id = await makePreview(u, offer);
    await sweep(g.port);
    expect((await post(`/offer-changes/${id}/confirm`, u.id)).statusCode).toBe(200);
    await pg.query(`update creatives set youtube_video_id = 'new' || substr(md5(random()::text), 1, 8) where offer_change_id = $1`, [id]);
    return id;
  }

  it("approve-then-swap: the new ad joins the same ad group, the old one is paused only after approval", async () => {
    const u = await user({ plan: "evergreen" });
    const g = fakeGoogle();
    const id = await toPublished(u, g);
    await sweep(g.port);
    expect(await statusOf(id)).toBe("pending_google");
    const add = g.calls.find((c) => c.op === "add")!.arg as { adGroup: string; finalUrl: string; status: string; videos: unknown[] };
    expect(add).toMatchObject({ adGroup: "customers/123/adGroups/9", finalUrl: "https://sparkle.test/?utm_source=youtube", status: "ENABLED" });
    expect(add.videos).toHaveLength(2);
    // Old ad still serving while Google reviews.
    expect(g.ads.get(AD)!.status).toBe("ENABLED");
    await sweep(g.port);
    expect(await statusOf(id)).toBe("pending_google");

    const [{ google_ad_resource_name: newAd }] = (await pg.query<{ google_ad_resource_name: string }>(`select google_ad_resource_name from offer_changes where id = $1`, [id])).rows;
    g.ads.get(newAd)!.policy = "approved";
    await sweep(g.port);
    expect(await statusOf(id)).toBe("live");
    // The launch ad had an offer, so it is PAUSED (kept), not removed.
    expect(g.ads.get(AD)!.status).toBe("PAUSED");
    const c = await pg.query<{ live_offer_change_id: string; status: string }>(`select live_offer_change_id, status from campaigns where id = $1`, [u.campaign]);
    expect(c.rows[0]).toEqual({ live_offer_change_id: id, status: "live" });
    // The new cuts point at the new ad (never re-published).
    const cuts = await pg.query<{ g: string }>(`select google_ad_resource_name g from creatives where offer_change_id = $1`, [id]);
    expect(cuts.rows.every((r) => r.g === newAd)).toBe(true);
  });

  it("disapproval removes the NEW ad, keeps the old one and pages ops", async () => {
    const u = await user({ plan: "evergreen" });
    const g = fakeGoogle();
    const id = await toPublished(u, g);
    await sweep(g.port);
    const [{ google_ad_resource_name: newAd }] = (await pg.query<{ google_ad_resource_name: string }>(`select google_ad_resource_name from offer_changes where id = $1`, [id])).rows;
    g.ads.get(newAd)!.policy = "disapproved";
    await sweep(g.port);
    expect(await statusOf(id)).toBe("disapproved");
    expect(g.ads.get(newAd)!.status).toBe("REMOVED");
    expect(g.ads.get(AD)!.status).toBe("ENABLED");
    expect(holder.alerts.some((a) => /disapproved/i.test(a.title))).toBe(true);
    // The included change is given back.
    expect((await get(`/campaigns/${u.campaign}/offer-changes`, u.id)).json().quote.charge).toBe("included");
  });

  it("end date: back to the base ad in one mutate; the campaign keeps running", async () => {
    const u = await user({ plan: "evergreen" });
    const g = fakeGoogle();
    // The base cut (queued with the first change) renders, publishes and parks PAUSED.
    const id = await toPublished(u, g);
    const [{ id: baseId }] = (await pg.query<{ id: string }>(`select id from offer_changes where campaign_id = $1 and kind = 'base'`, [u.campaign])).rows;
    await pg.query(`update creatives set render_status = 'ready', video_key = 'b.mp4' where offer_change_id = $1`, [baseId]);
    await sweep(g.port); // base -> publishing ; offer -> pending_google
    await pg.query(`update creatives set youtube_video_id = 'base' || substr(md5(random()::text), 1, 7) where offer_change_id = $1`, [baseId]);
    await sweep(g.port); // base parked
    expect(await statusOf(baseId)).toBe("parked");
    const baseAd = (await pg.query<{ b: string }>(`select base_ad_resource_name b from campaigns where id = $1`, [u.campaign])).rows[0]!.b;
    expect(g.ads.get(baseAd)!.status).toBe("PAUSED");

    const [{ google_ad_resource_name: offerAd, ends_at }] = (await pg.query<{ google_ad_resource_name: string; ends_at: Date }>(`select google_ad_resource_name, ends_at from offer_changes where id = $1`, [id])).rows;
    g.ads.get(offerAd)!.policy = "approved";
    await sweep(g.port);
    expect(await statusOf(id)).toBe("live");

    await sweep(g.port, new Date(new Date(ends_at).getTime() + 1000));
    expect(await statusOf(id)).toBe("ended");
    const swap = g.calls.filter((c) => c.op === "status").at(-1)!.arg;
    expect(swap).toEqual({ enable: [baseAd], remove: [offerAd] });
    expect(g.ads.get(baseAd)!.status).toBe("ENABLED");
    const c = await pg.query<{ live_offer_change_id: string | null; status: string }>(`select live_offer_change_id, status from campaigns where id = $1`, [u.campaign]);
    expect(c.rows[0]).toEqual({ live_offer_change_id: null, status: "live" });
  });

  it("an expired offer with no base is paused (never left serving) and ops are paged", async () => {
    const u = await user({ plan: "evergreen" });
    const g = fakeGoogle();
    const id = await toPublished(u, g);
    await pg.query(`update offer_changes set status = 'failed' where campaign_id = $1 and kind = 'base'`, [u.campaign]);
    await sweep(g.port);
    const [{ google_ad_resource_name: offerAd, ends_at }] = (await pg.query<{ google_ad_resource_name: string; ends_at: Date }>(`select google_ad_resource_name, ends_at from offer_changes where id = $1`, [id])).rows;
    g.ads.get(offerAd)!.policy = "approved";
    await sweep(g.port);
    await sweep(g.port, new Date(new Date(ends_at).getTime() + 1000));
    expect(await statusOf(id)).toBe("ended");
    expect(g.ads.get(offerAd)!.status).toBe("PAUSED");
    expect(holder.alerts.some((a) => /no base/i.test(a.title))).toBe(true);
  });
});

describe("WhatsApp stays inert without its env", () => {
  it("handleSwapInbound does nothing and the page says WhatsApp is off", async () => {
    const { handleSwapInbound } = await import("../lib/offerSwap/whatsapp.js");
    const r = await handleSwapInbound({ providerRef: "wamid.1", from: "15551234567", body: "$10 off", timestamp: new Date(), kind: "text" });
    expect(r).toEqual({ handled: false });
    const u = await user({ plan: "evergreen" });
    expect((await get(`/campaigns/${u.campaign}/offer-changes`, u.id)).json().whatsappEnabled).toBe(false);
  });
});

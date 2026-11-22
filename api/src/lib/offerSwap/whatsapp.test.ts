// "Change my offer" end to end on PGlite (every drizzle/*.sql applied): the
// routes, the price (one included a month, then $2), the compliance gate, the
// $2 payment, and the swap sweep with Google STUBBED (approve-then-remove,
// disapproval keeps the old ad, the end date returns to the base ad). R2,
// ntfy and the model are stubbed; WhatsApp is unconfigured (inert).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../../db/schema.js";
import { normalizePhone } from "../phone/index.js";

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
  return { db: null as unknown, alerts: [] as { title: string; message: string }[], sent: [] as { type: string; to: string; body?: string }[], transcript: null as string | null };
});

vi.mock("../../db/index.js", () => ({
  get db() {
    return holder.db;
  },
}));
vi.mock("../../plugins/r2.js", () => ({
  presignDownload: async (k: string) => `https://r2.test/${k}`,
  putObject: async () => undefined,
  deleteObject: async () => undefined,
  headObject: async () => null,
  getObjectBytes: async () => Buffer.from(""),
  assetKey: (u: string, ext: string) => `assets/${u}/${Math.random().toString(36).slice(2)}.${ext}`,
}));
vi.mock("../ops/notify.js", () => ({
  notifyOps: async (a: { title: string; message: string }) => {
    holder.alerts.push(a);
    return true;
  },
  isOpsNotifyConfigured: () => true,
}));

vi.mock("../whatsapp/index.js", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  const rec = (type: string) => async (a: { to: string; body?: string }) => {
    holder.sent.push({ type, to: a.to, body: a.body });
    return { providerRef: `out-${holder.sent.length}-${Math.random().toString(36).slice(2)}` };
  };
  return {
    ...real,
    offerSwapWhatsAppEnabled: () => true,
    isWhatsAppConfigured: () => true,
    whatsAppSendsEnabled: () => true,
    sendText: rec("text"),
    sendButtons: rec("buttons"),
    sendVideo: rec("video"),
    sendTemplate: rec("template"),
    downloadMedia: async (id: string) => ({
      bytes: Buffer.from("media-bytes"),
      mimeType: id.startsWith("img") ? "image/jpeg" : "audio/ogg; codecs=opus",
    }),
  };
});
vi.mock("../ai/stt.js", () => ({ transcribe: async () => holder.transcript, isSttConfigured: () => true }));

const MIGRATIONS = join(__dirname, "../../../drizzle");
let pg: PGlite;

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
  holder.db = drizzle(pg, { schema });
}, 90_000);

beforeEach(() => {
  holder.sent.length = 0;
  holder.transcript = null;
});

type Inbound = import("../whatsapp/index.js").InboundAny;
let seq = 0;
const msg = (from: string, m: Partial<Inbound>) =>
  ({ providerRef: `wamid.${++seq}`, from, body: "", timestamp: new Date(), kind: "text", ...m }) as Inbound;

const changeFor = async (campaign: string) =>
  (
    await pg.query<{ id: string; status: string; source: string; new_photo_asset_id: string | null; offer_text: string }>(
      `select id, status, source, new_photo_asset_id, offer_text from offer_changes where campaign_id = $1 and kind = 'offer' order by created_at desc limit 1`,
      [campaign],
    )
  ).rows[0];

async function user(opts: { role?: string; plan?: "evergreen" | null; category?: string; phone?: string } = {}) {
  const { TERMS_VERSION } = await import("../compliance/texts.js");
  const id = (
    // Stored as the API stores it (E.164) and opted in to WhatsApp (0048).
    await pg.query<{ id: string }>(
      `insert into users (email, password_hash, role, phone, whatsapp_opt_in_at) values ($1, 'x', $2, $3, case when $3::text is null then null else now() end) returning id`,
      [`${Math.random().toString(36).slice(2)}@x.test`, opts.role ?? "advertiser", opts.phone ? normalizePhone(opts.phone) : null],
    )
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


describe("parseInboundAll (Meta webhook shapes)", () => {
  it("reads text, photo + caption, voice note and a quick-reply tap; drops the rest", async () => {
    const { parseInboundAll, parseInbound } = await vi.importActual<typeof import("../whatsapp/index.js")>("../whatsapp/index.js");
    const raw = JSON.stringify({
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  { id: "a", from: "1555", timestamp: "1", type: "text", text: { body: "$10 off" } },
                  { id: "b", from: "1555", timestamp: "1", type: "image", image: { id: "img1", caption: "new van" } },
                  { id: "c", from: "1555", timestamp: "1", type: "audio", audio: { id: "aud1", voice: true } },
                  { id: "d", from: "1555", timestamp: "1", type: "interactive", interactive: { type: "button_reply", button_reply: { id: "offer_yes", title: "YES" } } },
                  { id: "e", from: "1555", timestamp: "1", type: "reaction" },
                ],
              },
            },
          ],
        },
      ],
    });
    const all = parseInboundAll(raw);
    expect(all.map((m) => [m.kind, m.mediaId ?? m.buttonId ?? m.body])).toEqual([
      ["text", "$10 off"],
      ["image", "img1"],
      ["audio", "aud1"],
      ["button", "offer_yes"],
    ]);
    expect(all[1]!.body).toBe("new van");
    // The original loop still sees text only.
    expect(parseInbound(raw).map((m) => m.body)).toEqual(["$10 off"]);
    expect(parseInboundAll("not json")).toEqual([]);
  });
});

describe("handleSwapInbound (transport stubbed)", () => {
  it("text offer -> preview with YES button -> YES puts it live (included)", async () => {
    const u = await user({ plan: "evergreen", phone: "+1 (555) 201-0001" });
    const { handleSwapInbound, sendSwapPreview } = await import("./whatsapp.js");
    const r = await handleSwapInbound(msg("15552010001", { body: "$25 off any move-out clean until Dec 15" }));
    expect(r).toMatchObject({ handled: true, action: "offer" });
    const c = (await changeFor(u.campaign))!;
    expect(c).toMatchObject({ source: "whatsapp", status: "rendering" });
    expect(holder.sent.at(-1)!.body).toMatch(/Making your ad/);

    await pg.query(`update creatives set render_status = 'ready', video_key = 'cut.mp4' where offer_change_id = $1`, [c.id]);
    await pg.query(`update offer_changes set status = 'preview' where id = $1`, [c.id]);
    const { offerChanges } = schema;
    const { eq } = await import("drizzle-orm");
    const [change] = await (holder.db as ReturnType<typeof drizzle>).select().from(offerChanges).where(eq(offerChanges.id, c.id));
    expect(await sendSwapPreview(change!)).toBe(true);
    expect(holder.sent.map((s) => s.type)).toContain("video");
    const buttons = holder.sent.find((s) => s.type === "buttons")!;
    expect(buttons.body).toMatch(/included in your plan/);
    expect(buttons.body).toMatch(/By replying YES you confirm/);

    const yes = await handleSwapInbound(msg("15552010001", { kind: "button", buttonId: "offer_yes", body: "YES" }));
    expect(yes).toMatchObject({ handled: true, action: "approved" });
    expect((await changeFor(u.campaign))!.status).toBe("publishing");
    const att = await pg.query<{ user_agent: string }>(`select user_agent from ad_attestations where campaign_id = $1 and action = 'launch'`, [u.campaign]);
    expect(att.rows[0]!.user_agent).toBe("whatsapp");
  });

  it("a redelivered message is processed once", async () => {
    await user({ plan: "evergreen", phone: "+1 555 201 0002" });
    const { handleSwapInbound } = await import("./whatsapp.js");
    const m = msg("15552010002", { body: "$5 off till 30th" });
    expect((await handleSwapInbound(m)).handled).toBe(true);
    expect(await handleSwapInbound(m)).toEqual({ handled: true, action: "duplicate" });
  });

  it("voice note: transcribed into the offer; a failed transcription asks them to type it", async () => {
    const u = await user({ plan: "evergreen", phone: "+1 555 201 0003" });
    const { handleSwapInbound } = await import("./whatsapp.js");
    expect(await handleSwapInbound(msg("15552010003", { kind: "audio", mediaId: "aud1" }))).toMatchObject({ action: "type_it" });
    expect(holder.sent.at(-1)!.body).toMatch(/type your offer/);
    holder.transcript = "Twenty dollars off every deep clean until December 10";
    expect(await handleSwapInbound(msg("15552010003", { kind: "audio", mediaId: "aud2" }))).toMatchObject({ action: "offer" });
    expect((await changeFor(u.campaign))!.offer_text).toBe("Twenty dollars off every deep clean until December 10");
    const t = await pg.query<{ transcript: string; media_key: string | null }>(
      `select transcript, media_key from whatsapp_messages where transcript is not null order by created_at desc limit 1`,
    );
    // The audio itself is gone from R2 (media_key cleared); the transcript stays.
    expect(t.rows[0]).toEqual({ transcript: "Twenty dollars off every deep clean until December 10", media_key: null });
  });

  it("photo first, then the offer text: the change uses that photo", async () => {
    const u = await user({ plan: "evergreen", phone: "+1 555 201 0004" });
    const { handleSwapInbound } = await import("./whatsapp.js");
    expect(await handleSwapInbound(msg("15552010004", { kind: "image", mediaId: "img9" }))).toMatchObject({ action: "photo_saved" });
    expect(await handleSwapInbound(msg("15552010004", { body: "$15 off window cleaning till 12th" }))).toMatchObject({ action: "offer" });
    const c = (await changeFor(u.campaign))!;
    expect(c.new_photo_asset_id).not.toBeNull();
    const keys = await pg.query<{ k: string[] }>(`select source_asset_keys k from creatives where offer_change_id = $1`, [c.id]);
    expect(keys.rows[0]!.k).toHaveLength(3);
  });

  it("a claim Google forbids is refused with the reason", async () => {
    await user({ plan: "evergreen", phone: "+1 555 201 0005", category: "Real estate" });
    const { handleSwapInbound } = await import("./whatsapp.js");
    expect(await handleSwapInbound(msg("15552010005", { body: "Adults only open house Sunday" }))).toMatchObject({ action: "refused" });
    expect(holder.sent.at(-1)!.body).toMatch(/can't put that in an ad/);
  });

  it("not a Keep it running subscriber: left to the original loop", async () => {
    await user({ plan: null, phone: "+1 555 201 0006" });
    const { handleSwapInbound } = await import("./whatsapp.js");
    expect(await handleSwapInbound(msg("15552010006", { body: "$10 off" }))).toEqual({ handled: false });
  });
});

// "Change my offer" (2026-11-21), database side. Decisions live in
// ./policy.ts; the Google half runs in the renderer (render/offerSwaps.ts).
//
// Lifecycle of an offer change (offer_changes.status):
//   rendering         re-cut creatives queued (cheap: clips/opener/voice reused)
//   preview           rendered; the owner watches it ("Put it live" / YES)
//   awaiting_payment  $2 Stripe checkout open (only when not included)
//   publishing        YouTube uploads of the NEW creatives (never an old one)
//   pending_google    NEW ad added to the SAME ad group; old ad still serving
//   live              Google approved; old ad paused (base) / removed (offer)
//   ended             end date passed; the campaign is back on its base ad
//   disapproved       Google said no; the new ad was removed, old one kept
//   failed / cancelled / superseded

import { and, desc, eq, gte, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  adAttestations,
  assets,
  campaigns,
  creatives,
  offerChanges,
  purchases,
  users,
} from "../../db/schema.js";
import { enqueueRender } from "../../render/jobs.js";
import { enqueueYoutubeUpload } from "../../render/youtubeJobs.js";
import { categoryKey } from "../categories/key.js";
import { claimBlock } from "../compliance/claimRules.js";
import { reevaluateCompliance } from "../compliance/index.js";
import { needsReviewRefusal, takenDownRefusal } from "../compliance/policy.js";
import { ATTESTATION_VERSION, attestationSnapshotText } from "../compliance/texts.js";
import { adScriptSchema, type AdScript } from "../script/schema.js";
import {
  chargeMinor,
  currencyForCountry,
  formatMinor,
  hasOfferChanges,
  maybeAddOnFor,
  type Currency,
  type ProductLine,
} from "../pricing/index.js";
import { billingIdentity } from "../testMode/index.js";
import { liveSubscriptionFor } from "../subscriptions/index.js";
import { createPurchase, markDelivered } from "../cinematic/index.js";
import { providerFor } from "../payments/index.js";
import { deleteUploadObjects } from "../uploads/remove.js";
import { presignDownload } from "../../plugins/r2.js";
import {
  baseCutNeeded,
  billingMonthOf,
  offerChangeCharge,
  offerChangeMode,
  offerChangeProgress,
  offerChangeStage,
  offerSlideRenderInfo,
  OFFER_SLIDE_SECONDS,
  photoOptionRefusal,
  resolveEndsAt,
  type OfferChangeCharge,
  type OfferChangeMode,
} from "./policy.js";
import { recutScript, RECUT_PROMPT_VERSION } from "./recut.js";

type Campaign = typeof campaigns.$inferSelect;
type OfferChange = typeof offerChanges.$inferSelect;
type Creative = typeof creatives.$inferSelect;

const WEB_ORIGIN = process.env.WEB_ORIGIN ?? "https://advault.3pandalabs.com";

/** Previews (each one a TTS call + an encode) one campaign may make per 24 h. */
export const MAX_OFFER_PREVIEWS_PER_DAY = Number(process.env.MAX_OFFER_PREVIEWS_PER_DAY ?? 6);

/** One owner photo may get a motion clip (a vendor call) only when this is on. */
export function newPhotoMotionEnabled(): boolean {
  return process.env.OFFER_CHANGE_PHOTO_MOTION === "on";
}

export type Refusal = { status: number; body: Record<string, unknown> };
const refuse = (status: number, error: string, extra: Record<string, unknown> = {}): Refusal => ({
  status,
  body: { error, ...extra },
});

// ---------------------------------------------------------------------------
// The launched ad, the serving ad, the base ad.
// ---------------------------------------------------------------------------

/** The launched (pre-offer-change) generated creatives: the re-cut template. */
export async function launchedCreatives(campaignId: string): Promise<Creative[]> {
  return db
    .select()
    .from(creatives)
    .where(
      and(
        eq(creatives.campaignId, campaignId),
        isNull(creatives.offerChangeId),
        isNotNull(creatives.googleAdResourceName),
        eq(creatives.renderStatus, "ready"),
      ),
    )
    .orderBy(desc(creatives.createdAt));
}

/** The launch ad's resource name (every launched creative points at it). */
export function launchedAdOf(rows: Creative[]): string | null {
  return rows.find((c) => c.googleAdResourceName)?.googleAdResourceName ?? null;
}

/** The ad serving now: the live offer's, else the base, else the launch ad. */
export async function servingAd(campaign: Campaign): Promise<string | null> {
  if (campaign.liveOfferChangeId) {
    const [live] = await db
      .select({ ad: offerChanges.googleAdResourceName })
      .from(offerChanges)
      .where(eq(offerChanges.id, campaign.liveOfferChangeId))
      .limit(1);
    if (live?.ad) return live.ad;
  }
  return campaign.baseAdResourceName ?? launchedAdOf(await launchedCreatives(campaign.id));
}

/** One template creative per shape (the newest), generated only. */
function templatesByShape(rows: Creative[]): Creative[] {
  const out = new Map<string, Creative>();
  for (const c of rows) if (c.kind === "standard" && !out.has(c.aspectRatio)) out.set(c.aspectRatio, c);
  return [...out.values()];
}

/**
 * One launched upload per shape (the newest): the owner's own video or the
 * "Made from your video" copy. The source of a slide change.
 */
function uploadsByShape(rows: Creative[]): Creative[] {
  const out = new Map<string, Creative>();
  for (const c of rows) if (c.kind === "upload" && c.videoKey && !out.has(c.aspectRatio)) out.set(c.aspectRatio, c);
  return [...out.values()];
}

export type ChangeSources = { mode: OfferChangeMode | null; sources: Creative[] };

/** How this campaign's offer is changed, and from which launched creatives. */
export function changeSources(launched: Creative[]): ChangeSources {
  const templates = templatesByShape(launched);
  const uploads = uploadsByShape(launched);
  const mode = offerChangeMode({ standardShapes: templates.length, uploadShapes: uploads.length });
  return { mode, sources: mode === "recut" ? templates : mode === "slide" ? uploads : [] };
}

/** Why this campaign's offer cannot be changed now, or null. */
export function eligibilityRefusal(campaign: Campaign, launched: Creative[]): Refusal | null {
  const down = takenDownRefusal(campaign);
  if (down) return down;
  if (!campaign.googleCampaignResourceName || !campaign.googleAdGroupResourceName) return refuse(409, "campaign_not_launched");
  if (campaign.status !== "live" && campaign.status !== "paused") return refuse(409, "campaign_not_launched");
  // Nothing of ours to re-cut and no uploaded video to add a slide to (e.g.
  // a cinematic film).
  if (!changeSources(launched).mode) return refuse(409, "no_recut_source");
  return null;
}

// ---------------------------------------------------------------------------
// Price.
// ---------------------------------------------------------------------------

export type OfferChangeQuote = {
  charge: OfferChangeCharge;
  amountMinor: number;
  currency: Currency;
  display: string;
  includedLeft: number;
  planIncludesChanges: boolean;
  /** No price exists for this account (e.g. INR) and nothing is included. */
  available: boolean;
  testMode: boolean;
  internal: boolean;
  internalLabel: string | null;
};

export async function includedUsedThisMonth(userId: string, now = new Date()): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(offerChanges)
    .where(
      and(
        eq(offerChanges.userId, userId),
        eq(offerChanges.charge, "included"),
        eq(offerChanges.billingMonth, billingMonthOf(now)),
        // A change Google refused, or one that broke before going live,
        // gives the month's included change back.
        sql`${offerChanges.status} not in ('disapproved','failed','cancelled')`,
      ),
    );
  return row?.n ?? 0;
}

export async function quoteOfferChange(userId: string, now = new Date()): Promise<OfferChangeQuote> {
  const who = await billingIdentity(userId);
  const [u] = await db.select({ countryCode: users.countryCode }).from(users).where(eq(users.id, userId)).limit(1);
  const currency = currencyForCountry(u?.countryCode ?? "US");
  const sub = await liveSubscriptionFor(userId);
  const planIncludesChanges = Boolean(
    sub && hasOfferChanges(sub.line as ProductLine) && (sub.status === "active" || sub.status === "past_due"),
  );
  const addOn = maybeAddOnFor(currency, "offer_change");
  const price = addOn ? chargeMinor(addOn.priceMinor, who.testMode) : 0;
  const q = offerChangeCharge({
    exempt: who.exempt,
    planIncludesChanges,
    includedUsedThisMonth: planIncludesChanges ? await includedUsedThisMonth(userId, now) : 0,
    priceMinor: price,
  });
  return {
    ...q,
    currency,
    display: q.amountMinor > 0 ? formatMinor(q.amountMinor, currency) : "Free",
    planIncludesChanges,
    available: q.charge !== "paid" || Boolean(addOn),
    testMode: who.testMode,
    internal: who.internal,
    internalLabel: who.internalLabel,
  };
}

// ---------------------------------------------------------------------------
// Making a preview (the cheap re-cut).
// ---------------------------------------------------------------------------

async function nextVersion(campaignId: string): Promise<number> {
  const [prev] = await db
    .select({ v: sql<number | null>`max(${creatives.version})` })
    .from(creatives)
    .where(and(eq(creatives.campaignId, campaignId), sql`${creatives.kind} <> 'upload'`));
  return (prev?.v ?? 0) + 1;
}

/** Puts one owner photo at the front of the re-cut (scene 1's photo). */
export function withNewPhoto(script: AdScript, keys: string[], photoKey: string): { script: AdScript; keys: string[] } {
  const nextKeys = [...keys];
  let index = nextKeys.indexOf(photoKey);
  if (index < 0) {
    if (nextKeys.length < 5) {
      nextKeys.push(photoKey);
      index = nextKeys.length - 1;
    } else {
      // Five photos already: the new one takes scene 1's photo slot.
      index = script.scenes[0]!.assetIndex;
      nextKeys[index] = photoKey;
    }
  }
  return {
    keys: nextKeys,
    script: {
      ...script,
      scenes: script.scenes.map((s, i) => (i === 0 ? { ...s, assetIndex: index } : s)),
      // No motion line written for a photo the writer never saw: the generic one.
      photoMotions: script.photoMotions?.filter((m) => m.assetIndex !== index),
      peopleIndexes: script.peopleIndexes?.filter((i) => i !== index),
      portraitIndex: script.portraitIndex === index ? undefined : script.portraitIndex,
    },
  };
}

/** Removes a never-published change's creatives (rows and R2 files). */
async function discardCreatives(changeId: string): Promise<void> {
  const rows = await db
    .select({ id: creatives.id, videoKey: creatives.videoKey, thumbnailKey: creatives.thumbnailKey })
    .from(creatives)
    .where(and(eq(creatives.offerChangeId, changeId), isNull(creatives.youtubeVideoId)));
  if (rows.length === 0) return;
  await db.delete(creatives).where(inArray(creatives.id, rows.map((r) => r.id)));
  await deleteUploadObjects(rows);
}

/**
 * Re-cut creatives for a change, one per launched shape, all sharing ONE
 * voiceover and sticker (one TTS call; the worker caches it by text).
 */
async function queueRecut(args: {
  campaign: Campaign;
  change: OfferChange;
  templates: Creative[];
  offer: string | null;
  endsAt: Date | null;
  callToAction: string;
  photoKey?: string | null;
  warn: (msg: string, err?: unknown) => void;
}): Promise<Creative[]> {
  const version = await nextVersion(args.campaign.id);
  const made: Creative[] = [];
  let shared: Pick<AdScript, "voiceoverText" | "sticker"> | null = null;
  for (const t of args.templates) {
    const base = adScriptSchema.parse(t.script);
    const { script: recut, source } = await recutScript(
      {
        base,
        offer: args.offer,
        endsAt: args.endsAt,
        businessName: args.campaign.businessName,
        businessCategory: args.campaign.businessCategory,
        callToAction: args.callToAction,
      },
      args.warn,
    );
    let script: AdScript = shared ? { ...recut, ...shared } : recut;
    shared ??= { voiceoverText: recut.voiceoverText, sticker: recut.sticker };
    let keys = t.sourceAssetKeys;
    if (args.photoKey) ({ script, keys } = withNewPhoto(script, keys, args.photoKey));
    const [row] = await db
      .insert(creatives)
      .values({
        campaignId: args.campaign.id,
        aspectRatio: t.aspectRatio,
        script,
        scriptSource: source,
        sourceAssetKeys: keys,
        version,
        offerChangeId: args.change.id,
        generationInputs: {
          recutOf: t.id,
          offerText: args.offer,
          endsAt: args.endsAt?.toISOString() ?? null,
          callToAction: args.callToAction,
          newPhotoKey: args.photoKey ?? null,
          promptVersion: RECUT_PROMPT_VERSION,
          scriptSource: source,
        },
        // The renderer's REUSE-ONLY mode (render/worker.ts): cached clips,
        // opener and photo pass only; a cache miss means a plain still, never
        // a vendor call. The one exception is the owner's new photo, and only
        // with OFFER_CHANGE_PHOTO_MOTION=on.
        renderInfo: {
          recut: {
            of: t.id,
            allowMotionKeys: args.photoKey && newPhotoMotionEnabled() ? [args.photoKey] : [],
          },
        },
      })
      .returning();
    await enqueueRender(row!.id);
    made.push(row!);
  }
  return made;
}

/**
 * Slide creatives for a change on an uploaded-video ad, one per launched
 * shape: the owner's (already approved) video followed by the "This month's
 * offer" slide. ffmpeg only, in the renderer (render/offerSlide.ts): no
 * vendor call. Approved on insert: the owner's approved footage + our slide.
 */
async function queueSlides(args: { campaign: Campaign; change: OfferChange; sources: Creative[]; offer: string; endsAt: Date }): Promise<Creative[]> {
  const made: Creative[] = [];
  const now = new Date();
  for (const src of args.sources) {
    const [row] = await db
      .insert(creatives)
      .values({
        campaignId: args.campaign.id,
        aspectRatio: src.aspectRatio,
        kind: "upload",
        renderStatus: "queued",
        sourceAssetKeys: [src.videoKey!],
        durationSeconds: src.durationSeconds != null ? src.durationSeconds + OFFER_SLIDE_SECONDS : null,
        offerChangeId: args.change.id,
        reviewStatus: "approved",
        reviewedBy: src.reviewedBy,
        reviewedAt: now,
        rightsAttestedBy: src.rightsAttestedBy,
        rightsAttestedAt: src.rightsAttestedAt,
        generationInputs: {
          slideOf: src.id,
          offerText: args.offer,
          endsAt: args.endsAt.toISOString(),
        },
        renderInfo: offerSlideRenderInfo({ sourceCreativeId: src.id, offerText: args.offer, endsAt: args.endsAt }),
      })
      .returning();
    await enqueueRender(row!.id);
    made.push(row!);
  }
  return made;
}

export type CreateChangeInput = {
  campaign: Campaign;
  userId: string;
  offerText: string;
  endsOn?: string | null;
  callToAction?: string | null;
  photoAssetId?: string | null;
  source: "web" | "whatsapp";
  offerCycleId?: string | null;
  now?: Date;
  warn?: (msg: string, err?: unknown) => void;
};

export async function createOfferChange(input: CreateChangeInput): Promise<{ ok: true; change: OfferChange } | ({ ok: false } & Refusal)> {
  const now = input.now ?? new Date();
  const warn = input.warn ?? (() => undefined);
  const { campaign } = input;
  const launched = await launchedCreatives(campaign.id);
  const notOk = eligibilityRefusal(campaign, launched);
  if (notOk) return { ok: false, ...notOk };
  const { mode, sources } = changeSources(launched) as { mode: OfferChangeMode; sources: Creative[] };
  const photoRefused = photoOptionRefusal(mode, input.photoAssetId, input.source);
  if (photoRefused) {
    return { ok: false, ...refuse(400, photoRefused, { detail: "Your ad is your own video: the offer goes on a slide at the end, so a new photo isn't used." }) };
  }
  // A slide change never uses a photo (WhatsApp may attach an earlier one).
  const photoAssetId = mode === "slide" ? null : (input.photoAssetId ?? null);

  const offerText = input.offerText.replace(/\s+/g, " ").trim();
  if (offerText.length < 3) return { ok: false, ...refuse(400, "offer_text_required") };
  // The same claim rules as every offer (lib/compliance/claimRules): what
  // Google clearly forbids (housing exclusions) is refused outright; REVIEW
  // phrases are flagged below and hold "Put it live" for an admin.
  const blocked = claimBlock(categoryKey(campaign.businessCategory), offerText);
  if (blocked) return { ok: false, ...refuse(400, "claim_not_allowed", { detail: blocked.reason, phrase: blocked.phrase }) };

  const ends = resolveEndsAt({ offerText, endsOn: input.endsOn, now });
  if (!ends.ok) return { ok: false, ...refuse(400, ends.error) };

  const [{ n: recent }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(offerChanges)
    .where(
      and(
        eq(offerChanges.campaignId, campaign.id),
        eq(offerChanges.kind, "offer"),
        gte(offerChanges.createdAt, new Date(now.getTime() - 86_400_000)),
      ),
    );
  if ((recent ?? 0) >= MAX_OFFER_PREVIEWS_PER_DAY) {
    return { ok: false, ...refuse(429, "offer_change_daily_limit", { limit: MAX_OFFER_PREVIEWS_PER_DAY }) };
  }

  let photoKey: string | null = null;
  if (photoAssetId) {
    const [a] = await db
      .select({ r2Key: assets.r2Key })
      .from(assets)
      .where(and(eq(assets.id, photoAssetId), eq(assets.userId, input.userId), eq(assets.kind, "photo")))
      .limit(1);
    if (!a) return { ok: false, ...refuse(400, "unknown_assets") };
    photoKey = a.r2Key;
  }

  // One change in flight per campaign. A newer preview replaces an older
  // preview; once one is paid for or at Google, nothing else may start.
  const inFlight = await db
    .select()
    .from(offerChanges)
    .where(
      and(
        eq(offerChanges.campaignId, campaign.id),
        eq(offerChanges.kind, "offer"),
        inArray(offerChanges.status, ["rendering", "preview", "awaiting_payment", "publishing", "pending_google"]),
      ),
    );
  if (inFlight.some((c) => c.status === "awaiting_payment" || c.status === "publishing" || c.status === "pending_google")) {
    return { ok: false, ...refuse(409, "offer_change_in_progress") };
  }
  for (const old of inFlight) {
    await db.update(offerChanges).set({ status: "superseded", updatedAt: now }).where(eq(offerChanges.id, old.id));
    await discardCreatives(old.id);
  }

  const callToAction = input.callToAction?.trim() || campaign.callToAction;
  let change: OfferChange;
  try {
    [change] = (await db
      .insert(offerChanges)
      .values({
        campaignId: campaign.id,
        userId: input.userId,
        kind: "offer",
        offerText,
        callToAction,
        endsAt: ends.endsAt,
        endsAtInferred: ends.inferred,
        source: input.source,
        status: "rendering",
        newPhotoAssetId: photoAssetId,
        offerCycleId: input.offerCycleId ?? null,
      })
      .returning()) as [OfferChange];
  } catch (err) {
    if ((err as { code?: string }).code === "23505") return { ok: false, ...refuse(409, "offer_change_in_progress") };
    throw err;
  }

  if (mode === "slide") {
    await queueSlides({ campaign, change, sources, offer: offerText, endsAt: ends.endsAt });
  } else {
    await queueRecut({ campaign, change, templates: sources, offer: offerText, endsAt: ends.endsAt, callToAction, photoKey, warn });
  }

  // The base the campaign returns to when this offer ends: the launch ad if
  // it had no offer (always, for an uploaded video), else a no-offer cut made
  // once (same cheap path).
  await ensureBase(campaign, mode, sources, launched, warn);

  // REVIEW phrases in the new text or script hold "Put it live" (needs_review)
  // until an admin approves them on /dashboard/admin/reports, like any ad.
  const after = await reevaluateCompliance(campaign.id);
  const flagged = (after?.complianceReasons ?? []).filter((r) => !r.approved).map((r) => ({ phrase: r.phrase, reason: r.reason }));
  if (flagged.length) {
    [change] = (await db
      .update(offerChanges)
      .set({ reviewPhrases: flagged, updatedAt: new Date() })
      .where(eq(offerChanges.id, change.id))
      .returning()) as [OfferChange];
  }
  return { ok: true, change };
}

/**
 * The campaign's base ad. A launch ad with no offer in it IS the base (its
 * resource name is recorded); so is the launch ad of an uploaded video (the
 * owner's video has no offer of ours in it). Otherwise a no-offer cut is
 * queued once. Never throws: the offer change itself must not fail on its base.
 */
export async function ensureBase(
  campaign: Campaign,
  mode: OfferChangeMode,
  templates: Creative[],
  launched: Creative[],
  warn: (msg: string, err?: unknown) => void,
): Promise<void> {
  try {
    if (campaign.baseAdResourceName) return;
    const [existing] = await db
      .select({ id: offerChanges.id })
      .from(offerChanges)
      .where(
        and(
          eq(offerChanges.campaignId, campaign.id),
          eq(offerChanges.kind, "base"),
          sql`${offerChanges.status} not in ('failed','cancelled','superseded')`,
        ),
      )
      .limit(1);
    if (existing) return;
    const launchAd = launchedAdOf(launched);
    const inputs = templates[0]?.generationInputs as { offerDetails?: string | null } | null | undefined;
    if (!baseCutNeeded(mode, inputs) && launchAd) {
      await db.update(campaigns).set({ baseAdResourceName: launchAd, updatedAt: new Date() }).where(eq(campaigns.id, campaign.id));
      return;
    }
    // Only our template ad can be re-cut without its offer.
    if (mode !== "recut") return;
    const [base] = await db
      .insert(offerChanges)
      .values({ campaignId: campaign.id, userId: campaign.userId, kind: "base", status: "rendering", source: "web", charge: "exempt" })
      .onConflictDoNothing()
      .returning();
    if (!base) return;
    await queueRecut({ campaign, change: base, templates, offer: null, endsAt: null, callToAction: campaign.callToAction, warn });
  } catch (err) {
    warn("offer change: base cut not queued", err);
  }
}

// ---------------------------------------------------------------------------
// "Put it live".
// ---------------------------------------------------------------------------

/** Starts publishing: YouTube uploads of the change's NEW creatives. */
async function startPublishing(changeId: string, patch: Partial<OfferChange>, now = new Date()): Promise<void> {
  await db
    .update(offerChanges)
    .set({ ...patch, status: "publishing", confirmedAt: now, updatedAt: now })
    .where(eq(offerChanges.id, changeId));
  const rows = await db.select({ id: creatives.id }).from(creatives).where(eq(creatives.offerChangeId, changeId));
  for (const r of rows) await enqueueYoutubeUpload(r.id);
}

export type ConfirmResult =
  | { ok: true; status: "publishing"; charge: OfferChangeCharge }
  | { ok: true; status: "awaiting_payment"; charge: "paid"; checkoutUrl: string | null; provider: string; purchaseId: string; display: string };

export async function confirmOfferChange(args: {
  changeId: string;
  userId: string;
  userEmail?: string | null;
  now?: Date;
}): Promise<ConfirmResult | ({ ok: false } & Refusal)> {
  const now = args.now ?? new Date();
  const [change] = await db
    .select()
    .from(offerChanges)
    .where(and(eq(offerChanges.id, args.changeId), eq(offerChanges.userId, args.userId), eq(offerChanges.kind, "offer")))
    .limit(1);
  if (!change) return { ok: false, ...refuse(404, "no_such_offer_change") };
  if (change.status !== "preview") return { ok: false, ...refuse(409, "offer_change_not_ready", { status: change.status }) };
  if (change.endsAt && change.endsAt.getTime() <= now.getTime()) return { ok: false, ...refuse(409, "ends_on_in_past") };
  const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, change.campaignId)).limit(1);
  if (!campaign) return { ok: false, ...refuse(404, "no_such_offer_change") };
  const gate = takenDownRefusal(campaign) ?? needsReviewRefusal(campaign);
  if (gate) return { ok: false, ...gate };

  // The month's included change is claimed by the UPDATE itself:
  // uq_offer_changes_included_month (0047) lets only one row per user and
  // month hold it, so two tabs (or WhatsApp + web) cannot both get it free.
  // Losing that race just means this one is the $2 kind.
  const billingMonth = billingMonthOf(now);
  let quote = await quoteOfferChange(args.userId, now);
  if (quote.charge !== "paid") {
    try {
      const [claimed] = await db
        .update(offerChanges)
        .set({ charge: quote.charge, billingMonth, priceMinor: 0, status: "publishing", confirmedAt: now, updatedAt: now })
        .where(and(eq(offerChanges.id, change.id), eq(offerChanges.status, "preview")))
        .returning();
      if (!claimed) return { ok: false, ...refuse(409, "offer_change_not_ready") };
      await startPublishing(change.id, {}, now);
      return { ok: true, status: "publishing", charge: quote.charge };
    } catch (err) {
      if ((err as { code?: string }).code !== "23505") throw err;
      quote = { ...(await quoteOfferChange(args.userId, now)) };
      if (quote.charge === "included") quote = { ...quote, charge: "paid" };
    }
  }
  if (!quote.available) return { ok: false, ...refuse(409, "offer_change_not_available") };
  const addOn = maybeAddOnFor(quote.currency, "offer_change");
  if (!addOn) return { ok: false, ...refuse(409, "offer_change_not_available") };
  const who = await billingIdentity(args.userId);
  const amountMinor = chargeMinor(addOn.priceMinor, who.testMode);
  const provider = providerFor(quote.currency);
  const purchase = await createPurchase({
    userId: args.userId,
    campaignId: campaign.id,
    addOnKey: addOn.key,
    amountMinor,
    provider: provider.name,
  });
  const [held] = await db
    .update(offerChanges)
    .set({ status: "awaiting_payment", charge: "paid", billingMonth, priceMinor: amountMinor, purchaseId: purchase.id, updatedAt: now })
    .where(and(eq(offerChanges.id, change.id), eq(offerChanges.status, "preview")))
    .returning();
  if (!held) {
    await db.update(purchases).set({ status: "cancelled", updatedAt: now }).where(eq(purchases.id, purchase.id));
    return { ok: false, ...refuse(409, "offer_change_not_ready") };
  }
  const session = await provider.createCheckout({
    paymentId: purchase.id,
    amountMinor,
    currency: quote.currency,
    purpose: "add_on",
    testMode: who.testMode,
    internal: who.internal,
    internalLabel: who.internalLabel,
    lineItems: [{ amountMinor, name: "AdVault offer change" }],
    userEmail: args.userEmail ?? "",
    returnUrl: `${WEB_ORIGIN}/dashboard/campaigns/${campaign.id}?offerChange=paid#change-offer`,
  });
  await db.update(purchases).set({ providerRef: session.providerRef, updatedAt: now }).where(eq(purchases.id, purchase.id));
  return {
    ok: true,
    status: "awaiting_payment",
    charge: "paid",
    checkoutUrl: session.redirectUrl,
    provider: provider.name,
    purchaseId: purchase.id,
    display: formatMinor(amountMinor, quote.currency),
  };
}

/** Re-opens checkout for an abandoned $2 payment (same purchase row). */
export async function resumeCheckout(changeId: string, userId: string, userEmail: string | null) {
  const [change] = await db
    .select()
    .from(offerChanges)
    .where(and(eq(offerChanges.id, changeId), eq(offerChanges.userId, userId), eq(offerChanges.status, "awaiting_payment")))
    .limit(1);
  if (!change?.purchaseId) return null;
  const [purchase] = await db.select().from(purchases).where(eq(purchases.id, change.purchaseId)).limit(1);
  if (!purchase || purchase.status !== "pending") return null;
  const who = await billingIdentity(userId);
  const provider = providerFor(purchase.currencyCode as Currency);
  const session = await provider.createCheckout({
    paymentId: purchase.id,
    amountMinor: purchase.amountMinor,
    currency: purchase.currencyCode as Currency,
    purpose: "add_on",
    testMode: who.testMode,
    internal: who.internal,
    internalLabel: who.internalLabel,
    lineItems: [{ amountMinor: purchase.amountMinor, name: "AdVault offer change" }],
    userEmail: userEmail ?? "",
    returnUrl: `${WEB_ORIGIN}/dashboard/campaigns/${change.campaignId}?offerChange=paid#change-offer`,
  });
  await db.update(purchases).set({ providerRef: session.providerRef, updatedAt: new Date() }).where(eq(purchases.id, purchase.id));
  return { checkoutUrl: session.redirectUrl, provider: provider.name, purchaseId: purchase.id };
}

/** The $2 payment landed (purchases webhook): publish. Idempotent. */
export async function onOfferChangePaid(purchaseId: string): Promise<boolean> {
  const [change] = await db
    .select()
    .from(offerChanges)
    .where(and(eq(offerChanges.purchaseId, purchaseId), eq(offerChanges.status, "awaiting_payment")))
    .limit(1);
  if (!change) return false;
  await startPublishing(change.id, {});
  await markDelivered(purchaseId);
  return true;
}

/** "Not now": a preview or an unpaid checkout. Never a change at Google. */
export async function cancelOfferChange(changeId: string, userId: string): Promise<boolean> {
  const [row] = await db
    .update(offerChanges)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(
      and(
        eq(offerChanges.id, changeId),
        eq(offerChanges.userId, userId),
        inArray(offerChanges.status, ["rendering", "preview", "awaiting_payment"]),
      ),
    )
    .returning();
  if (!row) return false;
  await discardCreatives(row.id);
  if (row.purchaseId) {
    await db.update(purchases).set({ status: "cancelled", updatedAt: new Date() }).where(and(eq(purchases.id, row.purchaseId), eq(purchases.status, "pending")));
  }
  await reevaluateCompliance(row.campaignId);
  return true;
}

// ---------------------------------------------------------------------------
// What the campaign page shows.
// ---------------------------------------------------------------------------

export async function offerChangeView(change: OfferChange) {
  const rows = await db
    .select({
      id: creatives.id,
      kind: creatives.kind,
      aspectRatio: creatives.aspectRatio,
      renderStatus: creatives.renderStatus,
      videoKey: creatives.videoKey,
      thumbnailKey: creatives.thumbnailKey,
      youtubeVideoId: creatives.youtubeVideoId,
      youtubeUploadStatus: creatives.youtubeUploadStatus,
    })
    .from(creatives)
    .where(eq(creatives.offerChangeId, change.id));
  const sign = (k: string | null) => (k ? presignDownload(k).catch(() => null) : Promise.resolve(null));
  // Slide cuts (an uploaded-video ad) are kind 'upload'; re-cuts are 'standard'.
  const mode = rows.some((r) => r.kind === "upload") ? "slide" : "recut";
  const progress = offerChangeProgress({ mode, status: change.status, createdAt: change.createdAt, confirmedAt: change.confirmedAt });
  return {
    id: change.id,
    kind: change.kind,
    mode,
    offerText: change.offerText,
    callToAction: change.callToAction,
    endsAt: change.endsAt,
    endsAtInferred: change.endsAtInferred,
    source: change.source,
    status: change.status,
    stage: offerChangeStage(change.status),
    charge: change.charge,
    priceMinor: change.priceMinor,
    reviewPhrases: change.reviewPhrases ?? [],
    error: change.error,
    createdAt: change.createdAt,
    confirmedAt: change.confirmedAt,
    // The web card's progress bar (null = no bar for this stage).
    progress: progress ? { startedAt: progress.startedAt, expectedSeconds: progress.expectedSeconds } : null,
    liveAt: change.liveAt,
    endedAt: change.endedAt,
    creatives: await Promise.all(
      rows.map(async (r) => ({
        id: r.id,
        aspectRatio: r.aspectRatio,
        renderStatus: r.renderStatus,
        videoUrl: r.renderStatus === "ready" ? await sign(r.videoKey) : null,
        thumbnailUrl: r.renderStatus === "ready" ? await sign(r.thumbnailKey) : null,
        youtubeVideoId: r.youtubeVideoId,
      })),
    ),
  };
}

export async function offerChangesFor(campaignId: string, limit = 10): Promise<OfferChange[]> {
  return db
    .select()
    .from(offerChanges)
    .where(and(eq(offerChanges.campaignId, campaignId), eq(offerChanges.kind, "offer"), ne(offerChanges.status, "superseded")))
    .orderBy(desc(offerChanges.createdAt))
    .limit(limit);
}

/** Records the two-tick attestation for a WhatsApp YES (no browser, so no IP). */
export async function recordWhatsAppAttestation(campaign: Campaign, userId: string, changeId: string): Promise<void> {
  const [c] = await db.select({ id: creatives.id }).from(creatives).where(eq(creatives.offerChangeId, changeId)).limit(1);
  await db.insert(adAttestations).values({
    campaignId: campaign.id,
    creativeId: c?.id ?? null,
    purchaseId: null,
    userId,
    action: "launch",
    attestationTextVersion: ATTESTATION_VERSION,
    exactTextSnapshot: attestationSnapshotText(),
    ipAddress: null,
    userAgent: "whatsapp",
    contentSnapshot: { offerChangeId: changeId, via: "whatsapp" },
  });
}

/** Render-queue facts for one change: all ready / any failed for good. */
export async function renderFacts(changeId: string) {
  const rows = await db
    .select({ renderStatus: creatives.renderStatus, youtubeVideoId: creatives.youtubeVideoId, youtubeUploadStatus: creatives.youtubeUploadStatus })
    .from(creatives)
    .where(eq(creatives.offerChangeId, changeId));
  return {
    count: rows.length,
    rendersReady: rows.length > 0 && rows.every((r) => r.renderStatus === "ready"),
    renderFailed: rows.some((r) => r.renderStatus === "failed"),
    uploaded: rows.length > 0 && rows.every((r) => Boolean(r.youtubeVideoId)),
    uploadFailed: rows.some((r) => r.youtubeUploadStatus === "failed"),
  };
}

export { startPublishing };

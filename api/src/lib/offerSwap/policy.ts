// "Change my offer" (2026-11-21), the pure half: price, end date, the swap
// state machine, the re-cut script and the WhatsApp reply rules. No db, no
// fetch: lib/offerSwap/index.ts and render/offerSwaps.ts do the IO.
//
// What a change is: a CHEAP RE-CUT of the campaign's launched ad. The photo
// motion clips, the opener, the photo pass and the narrator are reused from
// R2; only the offer sticker, the end card, the captions and the voiceover
// change (one TTS call). The new cut is published as NEW creatives and added
// to the SAME ad group as a NEW ad; the old ad is paused or removed only
// after Google approves the new one. On the end date the campaign goes back
// to its BASE ad (no offer) and keeps running.

import type { AdScript, AdSticker } from "../script/schema.js";
import type { GooglePolicyLabel } from "../adMetrics/adPolicy.js";
import { classifyReply, inferOfferExpiry } from "../offers/policy.js";
import { OFFER_CHANGES_INCLUDED_PER_MONTH } from "../pricing/index.js";

// ---------------------------------------------------------------------------
// Price.
// ---------------------------------------------------------------------------

export type OfferChangeCharge = "included" | "paid" | "exempt";

/**
 * What this change costs. Admins / at_cost: free (exempt). A live Keep it
 * running plan includes OFFER_CHANGES_INCLUDED_PER_MONTH per calendar month
 * (UTC); every other change is the $2 price (50 cents in test mode, which the
 * caller passes in as priceMinor via chargeMinor).
 */
export function offerChangeCharge(args: {
  exempt: boolean;
  /** The user's live plan includes offer changes (hasOfferChanges). */
  planIncludesChanges: boolean;
  includedUsedThisMonth: number;
  priceMinor: number;
}): { charge: OfferChangeCharge; amountMinor: number; includedLeft: number } {
  const includedLeft = args.planIncludesChanges
    ? Math.max(0, OFFER_CHANGES_INCLUDED_PER_MONTH - args.includedUsedThisMonth)
    : 0;
  if (args.exempt) return { charge: "exempt", amountMinor: 0, includedLeft };
  if (includedLeft > 0) return { charge: "included", amountMinor: 0, includedLeft };
  return { charge: "paid", amountMinor: args.priceMinor, includedLeft: 0 };
}

/** The calendar month a change counts against: 'YYYY-MM-01' (UTC). */
export function billingMonthOf(now: Date): string {
  return `${now.toISOString().slice(0, 7)}-01`;
}

// ---------------------------------------------------------------------------
// End date. ALWAYS a date (same rule as inferOfferExpiry): an offer outliving
// its deadline sends people to a deal the shop will not honour.
// ---------------------------------------------------------------------------

/** Longest an offer may run before it must be renewed. */
export const MAX_OFFER_DAYS = 92;

export type EndsAtResult =
  | { ok: true; endsAt: Date; inferred: boolean }
  | { ok: false; error: "ends_on_invalid" | "ends_on_in_past" | "ends_on_too_far" };

/**
 * The owner's date (end of that day, UTC) when given, else inferred from the
 * text (end of month when nothing is stated, flagged `inferred`).
 */
export function resolveEndsAt(args: { offerText: string; endsOn?: string | null; now: Date }): EndsAtResult {
  const today = args.now.toISOString().slice(0, 10);
  if (args.endsOn) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(args.endsOn)) return { ok: false, error: "ends_on_invalid" };
    const d = new Date(`${args.endsOn}T23:59:59Z`);
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== args.endsOn) return { ok: false, error: "ends_on_invalid" };
    if (args.endsOn < today) return { ok: false, error: "ends_on_in_past" };
    if (d.getTime() - args.now.getTime() > MAX_OFFER_DAYS * 86_400_000) return { ok: false, error: "ends_on_too_far" };
    return { ok: true, endsAt: d, inferred: false };
  }
  const inferred = inferOfferExpiry(args.offerText, args.now);
  // An inferred date already behind us (e.g. "till 1st" typed on the 1st at
  // 23:59 UTC) still has to be a real end: end of month then.
  let endsAt = inferred.expiresAt;
  if (endsAt.getTime() <= args.now.getTime()) {
    endsAt = new Date(Date.UTC(args.now.getUTCFullYear(), args.now.getUTCMonth() + 1, 0, 23, 59, 59));
  }
  return { ok: true, endsAt, inferred: !inferred.parsed };
}

// ---------------------------------------------------------------------------
// The base ad.
// ---------------------------------------------------------------------------

/**
 * Does the campaign need a no-offer BASE cut made? Only when the launched ad
 * may carry an offer: its writer input had offer text, or (an ad from before
 * generation inputs were stored, migration 0043) we cannot tell, so we assume
 * it did. A clean launched ad IS the base, and nothing is made.
 */
export function needsBaseCut(launchedInputs: { offerDetails?: string | null } | null | undefined): boolean {
  if (!launchedInputs) return true;
  return Boolean(launchedInputs.offerDetails && launchedInputs.offerDetails.trim());
}

// ---------------------------------------------------------------------------
// Uploaded-video ads (2026-11-22): the owner's video + ONE end slide.
//
// A launched ad that is the owner's own video (kind 'upload', including the
// "Made from your video" reformat copies) has nothing of ours to re-cut. An
// offer change for it is the SAME video followed by a ~4 s "This month's
// offer" slide, made with ffmpeg only in the renderer (render/offerSlide.ts,
// render_info.engine = 'offer_slide'). Everything after the render is the
// usual flow. The base ad is the launch ad itself (the video has no offer of
// ours baked in), so no base cut is ever made for it.
// ---------------------------------------------------------------------------

/** How a change is made: re-cut our template ad, or add a slide to their video. */
export type OfferChangeMode = "recut" | "slide";

export const OFFER_SLIDE_ENGINE = "offer_slide";
export const OFFER_SLIDE_SECONDS = 4;
export const OFFER_SLIDE_HEADING = "This month's offer";

/**
 * Generated launched shapes win (the existing re-cut); else the owner's
 * uploaded shapes get the slide; else nothing can be changed.
 */
export function offerChangeMode(args: { standardShapes: number; uploadShapes: number }): OfferChangeMode | null {
  if (args.standardShapes > 0) return "recut";
  if (args.uploadShapes > 0) return "slide";
  return null;
}

/** Does this mode need a no-offer base cut made? A slide change never does. */
export function baseCutNeeded(mode: OfferChangeMode, launchedInputs: { offerDetails?: string | null } | null | undefined): boolean {
  return mode === "recut" && needsBaseCut(launchedInputs);
}

/**
 * The new photo / photo motion options only exist for re-cuts. Sent from the
 * web for an upload ad: a clear 400. (WhatsApp may attach a photo the owner
 * sent earlier; for a slide change it is simply not used.)
 */
export function photoOptionRefusal(mode: OfferChangeMode, photoAssetId: string | null | undefined, source: "web" | "whatsapp"): "photo_not_for_upload_ads" | null {
  return mode === "slide" && photoAssetId && source === "web" ? "photo_not_for_upload_ads" : null;
}

const MONTH_TITLE = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Until Dec 31" for the slide (UTC, like every end date here). */
export function untilLine(endsAt: Date): string {
  return `Until ${MONTH_TITLE[endsAt.getUTCMonth()]} ${endsAt.getUTCDate()}`;
}

const MONTH_SPOKEN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"}`;
}

/** "December 31st" for the voice-over (UTC, like untilLine). */
export function spokenDate(endsAt: Date): string {
  return `${MONTH_SPOKEN[endsAt.getUTCMonth()]} ${ordinal(endsAt.getUTCDate())}`;
}

/** Same pattern as lib/ai/voice stripAudioTags: "[warmly] " is a v3 audio tag. */
const AUDIO_TAG = /\[[a-z ]{2,30}\]\s*/gi;
/** The offer already says when it ends ("until Friday", "ends Dec 15"). */
const MENTIONS_END = /\b(until|till|til|thru|through|ends?|ending|expires?|valid to)\b/i;

/**
 * What the voice-over reads on the slide (2026-11-22, owner decision):
 * "This month's offer: $25 off any move-out clean. Until December 31st."
 * Deterministic, no model. Audio tags the owner typed are dropped (their text
 * is not stage directions), the offer gets one closing full stop, and the
 * date close is left out when the offer already says when it ends.
 */
export function offerSlideNarration(args: { offerText: string; endsAt: Date | null }): string {
  let offer = args.offerText.replace(AUDIO_TAG, "").replace(/\s+/g, " ").trim();
  offer = offer.replace(/[\s,;:\-–—]+$/, "");
  if (!offer) return "";
  if (!/[.!?…]$/.test(offer)) offer += ".";
  const close = args.endsAt && !MENTIONS_END.test(offer) ? ` Until ${spokenDate(args.endsAt)}.` : "";
  return `${OFFER_SLIDE_HEADING}: ${offer}${close}`;
}

export type OfferSlideInfo = {
  engine: typeof OFFER_SLIDE_ENGINE;
  /** The launched upload creative the video comes from. */
  from: string;
  slide: {
    heading: string;
    offer: string;
    until: string;
    /** The minimum; the renderer lengthens it to fit the voice-over (max 10 s). */
    seconds: number;
    /** What the voice-over reads (offerSlideNarration). */
    narration: string;
  };
};

/** render_info for one slide creative (the renderer reads it back). */
export function offerSlideRenderInfo(args: { sourceCreativeId: string; offerText: string; endsAt: Date }): OfferSlideInfo {
  return {
    engine: OFFER_SLIDE_ENGINE,
    from: args.sourceCreativeId,
    slide: {
      heading: OFFER_SLIDE_HEADING,
      offer: args.offerText.replace(/\s+/g, " ").trim(),
      until: untilLine(args.endsAt),
      seconds: OFFER_SLIDE_SECONDS,
      narration: offerSlideNarration({ offerText: args.offerText, endsAt: args.endsAt }),
    },
  };
}

/** The slide's texts when this render_info is an offer slide, else null. */
export function offerSlideOf(renderInfo: unknown): OfferSlideInfo["slide"] | null {
  const r = renderInfo as { engine?: unknown; slide?: Partial<OfferSlideInfo["slide"]> } | null | undefined;
  if (r?.engine !== OFFER_SLIDE_ENGINE || !r.slide || typeof r.slide.offer !== "string") return null;
  const until = typeof r.slide.until === "string" ? r.slide.until : "";
  return {
    heading: typeof r.slide.heading === "string" ? r.slide.heading : OFFER_SLIDE_HEADING,
    offer: r.slide.offer,
    until,
    seconds: typeof r.slide.seconds === "number" && r.slide.seconds > 0 && r.slide.seconds <= 10 ? r.slide.seconds : OFFER_SLIDE_SECONDS,
    // A slide queued before the voice-over shipped has no narration: read the
    // offer and the slide's own "Until Dec 31" line.
    narration:
      typeof r.slide.narration === "string"
        ? r.slide.narration
        : `${offerSlideNarration({ offerText: r.slide.offer, endsAt: null })}${until && !MENTIONS_END.test(r.slide.offer) ? ` ${until}.` : ""}`,
  };
}

// ---------------------------------------------------------------------------
// The swap state machine.
//
//   offer: rendering -> preview -> (awaiting_payment) -> publishing
//          -> pending_google -> live -> ended
//          (disapproved: the NEW ad is removed, the old one keeps running)
//   base:  rendering -> publishing -> parked (a PAUSED ad in the ad group,
//          so Google can review it before it is needed) -> live (serving
//          after an offer ended) ; superseded when a new base is made.
// ---------------------------------------------------------------------------

export type SwapFacts = {
  kind: "offer" | "base";
  status: string;
  /** Every creative of the change rendered. */
  rendersReady: boolean;
  /** A creative's render failed for good. */
  renderFailed: boolean;
  /** Every creative has a YouTube video id. */
  uploaded: boolean;
  uploadFailed: boolean;
  /** Google's verdict on the change's NEW ad (pending_google). */
  googlePolicy?: GooglePolicyLabel | null;
  googleAddedAt?: Date | null;
  opsAlertedAt?: Date | null;
  endsAt?: Date | null;
  now: Date;
};

export type SwapStep =
  | "wait"
  | "preview_ready"
  | "render_failed"
  | "add_to_google"
  | "park_base"
  | "upload_failed"
  | "promote"
  | "disapproved"
  | "alert_slow_review"
  | "restore_base";

/** Google usually reviews within a day; past this ops hear about it once. */
export const SLOW_REVIEW_HOURS = 48;

export function nextSwapStep(f: SwapFacts): SwapStep {
  switch (f.status) {
    case "rendering":
      if (f.renderFailed) return "render_failed";
      if (f.rendersReady) return f.kind === "base" ? "park_base" : "preview_ready";
      return "wait";
    case "publishing":
      if (f.uploadFailed) return "upload_failed";
      if (!f.uploaded) return "wait";
      return f.kind === "base" ? "park_base" : "add_to_google";
    case "pending_google": {
      if (f.googlePolicy === "approved" || f.googlePolicy === "approved_limited") return "promote";
      if (f.googlePolicy === "disapproved") return "disapproved";
      const since = f.googleAddedAt ? f.now.getTime() - f.googleAddedAt.getTime() : 0;
      if (!f.opsAlertedAt && since > SLOW_REVIEW_HOURS * 3_600_000) return "alert_slow_review";
      return "wait";
    }
    case "live":
      if (f.kind === "offer" && f.endsAt && f.now.getTime() >= f.endsAt.getTime()) return "restore_base";
      return "wait";
    default:
      return "wait";
  }
}

/**
 * What to do with the ad that was serving when the new one is approved.
 * The base / launched ad is PAUSED (it is what the campaign returns to); a
 * previous offer's ad is REMOVED (that offer is over and never comes back).
 */
export function replacedAdAction(replaced: string | null, baseAd: string | null): "pause" | "remove" | "none" {
  if (!replaced) return "none";
  return replaced === baseAd ? "pause" : "remove";
}

/** The status words the web page and WhatsApp use. */
export type OfferChangeStage =
  | "making"
  | "preview"
  | "waiting_payment"
  | "waiting_google"
  | "live"
  | "back_to_base"
  | "disapproved"
  | "failed"
  | "cancelled";

export function offerChangeStage(status: string): OfferChangeStage {
  switch (status) {
    case "rendering":
      return "making";
    case "preview":
      return "preview";
    case "awaiting_payment":
      return "waiting_payment";
    case "publishing":
    case "pending_google":
      return "waiting_google";
    case "live":
      return "live";
    case "ended":
      return "back_to_base";
    case "disapproved":
      return "disapproved";
    case "failed":
      return "failed";
    default:
      return "cancelled";
  }
}

/**
 * How long a stage usually takes, for the web card's progress bar (an honest
 * estimate: the renderer reports no progress). Measured 2026-11-22: a slide
 * cut (ffmpeg only) was ready in ~45 s; since it gets a voice-over (one TTS
 * call, 2026-11-22) allow ~75 s; a re-cut (template render, reuse-only)
 * takes a few minutes; publishing = the YouTube upload of each cut + adding
 * the ad at Google, which since then happens as soon as the uploads finish.
 */
export const OFFER_CHANGE_EXPECTED_SECONDS = { slide: 75, recut: 240, publishing: 120 } as const;

/**
 * What the progress bar runs against, or null for a stage with no bar.
 * `pending_google` deliberately has none: Google's review can take hours, and
 * a bar that sits at 95% for hours is a lie.
 */
export function offerChangeProgress(args: {
  mode: OfferChangeMode;
  status: string;
  createdAt: Date;
  confirmedAt: Date | null;
}): { startedAt: Date; expectedSeconds: number } | null {
  if (args.status === "rendering") return { startedAt: args.createdAt, expectedSeconds: OFFER_CHANGE_EXPECTED_SECONDS[args.mode] };
  if (args.status === "publishing") return { startedAt: args.confirmedAt ?? args.createdAt, expectedSeconds: OFFER_CHANGE_EXPECTED_SECONDS.publishing };
  return null;
}

// ---------------------------------------------------------------------------
// The re-cut script.
//
// Only the offer-bearing text may change: hook, scene captions, end card
// text, voiceover, sticker. Everything that would cost vendor money or
// change what the ad SHOWS is copied from the launched script: scene order,
// photos and durations (so the same motion clips line up), the per-photo
// motion lines and the opener prompt (their R2 cache keys), the narrator,
// and the marks lib/creatives/generate.ts sets (badges, before & after,
// people, portrait, end-card line).
// ---------------------------------------------------------------------------

export type RecutText = {
  hook: string;
  captions: string[];
  endCardText: string;
  voiceoverText: string;
  sticker: AdSticker;
};

function fit(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max + 1);
  const space = cut.lastIndexOf(" ");
  return (space > max / 2 ? cut.slice(0, space) : t.slice(0, max)).replace(/[,.;:\s-]+$/, "").trim();
}

/** Applies offer text to the launched script, keeping everything else exactly. */
export function mergeRecut(base: AdScript, text: RecutText): AdScript {
  return {
    ...base,
    hook: fit(text.hook, 80) || base.hook,
    scenes: base.scenes.map((s, i) => ({ ...s, caption: fit(text.captions[i] ?? s.caption, 60) || s.caption })),
    endCardText: fit(text.endCardText, 60) || base.endCardText,
    voiceoverText: fit(text.voiceoverText, 600) || base.voiceoverText,
    sticker: {
      badge: fit(text.sticker.badge.toUpperCase(), 10) || "LOCAL",
      headline: fit(text.sticker.headline.toUpperCase(), 24) || "NEAR YOU",
      tagline: fit(text.sticker.tagline.toUpperCase(), 26) || "NEAR YOU",
      benefits: text.sticker.benefits.map((b) => fit(b, 28)).filter(Boolean).slice(0, 2),
    },
  };
}

const MONTH_SHORT = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/** "UNTIL NOV 30" for the sticker tag. */
export function untilTag(endsAt: Date): string {
  return `UNTIL ${MONTH_SHORT[endsAt.getUTCMonth()]} ${endsAt.getUTCDate()}`;
}

/**
 * The owner's own price or discount, for the sticker badge: "$10 OFF",
 * "30% OFF", "$49", "FREE". Only what they typed, never invented.
 */
export function offerBadge(offer: string): string | null {
  const t = offer.toUpperCase();
  const off = t.match(/(\$\s?\d+(?:\.\d{2})?|\d{1,3}\s?%)\s*OFF\b/);
  if (off) return `${off[1].replace(/\s/g, "")} OFF`.slice(0, 10);
  const price = t.match(/\$\s?\d+(?:\.\d{2})?/);
  if (price) return price[0].replace(/\s/g, "").slice(0, 10);
  if (/\bFREE\b/.test(t)) return "FREE";
  return null;
}

/** First clause of the offer, cut on a boundary. Their words, shortened. */
export function offerHeadline(offer: string, max: number): string {
  const cleaned = offer.replace(/\s+/g, " ").trim();
  const first = cleaned.split(/(?<=[.!?])\s/)[0] ?? cleaned;
  return fit(first, max);
}

function audioTag(voiceover: string): string {
  return voiceover.match(/^\s*(\[[a-z ]{2,30}\])/i)?.[1] ?? "[warmly]";
}

/**
 * The re-cut without the model: the offer leads the sticker, the hook and
 * the first caption; the voiceover is the offer sentence, the business and
 * the call to action. `offer = null` is the BASE cut (no offer anywhere).
 */
export function deterministicRecut(args: {
  base: AdScript;
  offer: string | null;
  endsAt: Date | null;
  businessName: string;
  businessCategory: string;
  callToAction: string;
}): AdScript {
  const { base, offer } = args;
  const tag = audioTag(base.voiceoverText);
  const category = args.businessCategory.toLowerCase();
  if (!offer) {
    const captions = [args.businessName, `${args.businessCategory} near you`, args.callToAction];
    return mergeRecut(base, {
      hook: `${args.businessName}, ${category} near you`,
      captions: base.scenes.map((_, i) => captions[i % captions.length]!),
      endCardText: args.businessName,
      voiceoverText: `${tag} ${args.businessName}, your local ${category}. ${args.callToAction}.`,
      sticker: {
        badge: "LOCAL",
        headline: args.businessCategory || "NEAR YOU",
        tagline: "NEAR YOU",
        benefits: [],
      },
    });
  }
  const headline = offerHeadline(offer, 60);
  const sentence = offerHeadline(offer, 160);
  const captions = [headline, args.businessName, args.callToAction];
  return mergeRecut(base, {
    hook: offerHeadline(offer, 80),
    captions: base.scenes.map((_, i) => captions[i] ?? base.scenes[i]!.caption),
    endCardText: base.endCardText,
    voiceoverText: `${tag} ${/[.!?]$/.test(sentence) ? sentence : `${sentence}.`} ${args.businessName}, near you. ${args.callToAction}.`,
    sticker: {
      badge: offerBadge(offer) ?? "OFFER",
      headline: offerHeadline(offer, 24),
      tagline: args.endsAt ? untilTag(args.endsAt) : "NEAR YOU",
      benefits: [],
    },
  });
}

/**
 * Checks a model's re-cut text before it is used: the right number of
 * captions, nothing empty. A bad answer means the deterministic re-cut.
 */
export function validRecutText(x: unknown, sceneCount: number): x is RecutText {
  if (!x || typeof x !== "object") return false;
  const t = x as Record<string, unknown>;
  const str = (v: unknown) => typeof v === "string" && v.trim().length > 0;
  const sticker = t.sticker as Record<string, unknown> | undefined;
  return (
    str(t.hook) &&
    str(t.endCardText) &&
    str(t.voiceoverText) &&
    Array.isArray(t.captions) &&
    t.captions.length === sceneCount &&
    t.captions.every(str) &&
    !!sticker &&
    str(sticker.badge) &&
    str(sticker.headline) &&
    str(sticker.tagline) &&
    Array.isArray(sticker.benefits) &&
    sticker.benefits.every((b) => typeof b === "string")
  );
}

/** Every string an ad viewer sees or hears in a script (for the compliance check). */
export function scriptTexts(s: AdScript): string[] {
  return [
    s.hook,
    ...s.scenes.map((x) => x.caption),
    s.endCardText,
    s.voiceoverText,
    ...(s.sticker ? [s.sticker.badge, s.sticker.headline, s.sticker.tagline, ...s.sticker.benefits] : []),
  ];
}

// ---------------------------------------------------------------------------
// WhatsApp (render/offerSwaps.ts + lib/offerSwap/whatsapp.ts).
// ---------------------------------------------------------------------------

export type InboundKind = "text" | "image" | "audio" | "button";

export type SwapReplyIntent =
  | { intent: "offer"; text: string }
  | { intent: "photo"; caption: string | null }
  | { intent: "voice" }
  | { intent: "approve" }
  | { intent: "reject" }
  | { intent: "unclear" };

/** Quick-reply button ids on the preview message. */
export const BUTTON_APPROVE = "offer_yes";
export const BUTTON_REJECT = "offer_no";

/**
 * What an owner's message means for the offer-change loop. `awaiting` is
 * true while a preview is waiting for their YES. Text goes through the same
 * classifier as the original loop (Hinglish yes/no included).
 */
export function classifySwapReply(
  msg: { kind: InboundKind; text?: string | null; buttonId?: string | null },
  awaiting: boolean,
): SwapReplyIntent {
  if (msg.kind === "button") {
    if (msg.buttonId === BUTTON_APPROVE) return awaiting ? { intent: "approve" } : { intent: "unclear" };
    if (msg.buttonId === BUTTON_REJECT) return { intent: "reject" };
    return { intent: "unclear" };
  }
  if (msg.kind === "audio") return { intent: "voice" };
  if (msg.kind === "image") return { intent: "photo", caption: msg.text?.trim() || null };
  const r = classifyReply(msg.text ?? "", awaiting ? "previewed" : "prompted");
  if (r.intent === "approve") return { intent: "approve" };
  if (r.intent === "reject") return { intent: "reject" };
  if (r.intent === "offer") return { intent: "offer", text: r.text.slice(0, 500) };
  return { intent: "unclear" };
}

// Speech to text for voice notes: hard caps, then "please type it".
export const MAX_VOICE_BYTES = 2_000_000; // ~2 minutes of WhatsApp opus
export const MAX_VOICE_SECONDS = 90;
export const MAX_TRANSCRIPTIONS_PER_USER_PER_DAY = 6;

export function transcriptionAllowed(args: { bytes: number; seconds?: number | null; usedToday: number }): boolean {
  if (args.bytes <= 0 || args.bytes > MAX_VOICE_BYTES) return false;
  if (args.seconds != null && args.seconds > MAX_VOICE_SECONDS) return false;
  return args.usedToday < MAX_TRANSCRIPTIONS_PER_USER_PER_DAY;
}

const fmtDate = (d: Date) => d.toISOString().slice(0, 10);

export function swapPreviewMessage(args: {
  offer: string;
  endsAt: Date;
  inferred: boolean;
  priceDisplay: string | null;
  previewUrl: string | null;
}): string {
  const end = args.inferred
    ? `It runs until ${fmtDate(args.endsAt)}. Reply with a date to change that.`
    : `It runs until ${fmtDate(args.endsAt)}.`;
  const price = args.priceDisplay ? `This change costs ${args.priceDisplay}.` : "This change is included in your plan.";
  return [
    `Here's your ad with the new offer: "${args.offer}".`,
    args.previewUrl ? `Watch it: ${args.previewUrl}` : null,
    end,
    price,
    "Reply YES to put it live, or send a new offer.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function swapPaymentMessage(display: string, url: string): string {
  return `To put it live, pay ${display} here: ${url}\n\nWe'll send it to Google as soon as the payment goes through.`;
}

export function swapSubmittedMessage(): string {
  return "Sent to Google. Your current ad keeps running until Google approves the new one, usually within a day.";
}

export function swapLiveMessage(endsAt: Date): string {
  return `Your new offer is live. On ${fmtDate(endsAt)} your ad goes back to your regular ad and keeps running.`;
}

export function swapBackToBaseMessage(): string {
  return "Your offer has ended. Your regular ad is running again. Reply with a new offer any time.";
}

export function swapDisapprovedMessage(): string {
  return "Google did not approve the ad with your new offer, so your current ad keeps running. Reply with a different offer, or see the details on your campaign page.";
}

export function swapProblemMessage(): string {
  return "We couldn't make your new ad. Your current ad keeps running. We're looking into it; you can also try again on your campaign page.";
}

export function typeItMessage(): string {
  return "Sorry, we couldn't understand that voice note. Please type your offer, for example \"$10 off any cleaning until Dec 15\".";
}

export function notAllowedMessage(reason: string): string {
  return `We can't put that in an ad: ${reason} Please send a different offer.`;
}

export function noLiveCampaignMessage(): string {
  return "You don't have an ad running right now, so there's nothing to change. Open AdVault to launch one.";
}

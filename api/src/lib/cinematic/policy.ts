// Pure decisions for the cinematic add-on. No db, no fetch — see the sibling
// index.ts for anything that touches either.
//
// WHAT THIS PRODUCT IS, because it is easy to mistake for the normal render
// path with a better model bolted on:
//
// The monthly plans do IMAGE-to-video — they animate a photo the advertiser
// uploaded, and the photo is the ceiling. A badly lit storefront JPEG cannot be
// relit by a model that is only allowed to move within it, which is why a real
// Kling clip proved visually indistinguishable from the free zoompan filter
// when we tested it. This path does TEXT-to-video: the model invents the scene,
// so it owns the lighting, the lens and the composition. That is the whole
// reason the output can look like a vendor showreel, and the whole reason it is
// priced as a separate one-off rather than folded into a monthly plan.
//
// The advertiser's real photo then closes the ad. That is not decoration. A
// beautiful generated scene sells nothing on its own — the viewer needs "this
// is the shop two streets away", and only a real photo says that.

import type { AddOn } from "../pricing/index.js";

/** One generated shot. `seconds` is metered spend, so it is never free-form. */
export type CinematicShot = {
  /** What the model should film. Atmosphere only — see assertVisualIsClaimFree. */
  prompt: string;
  seconds: number;
  /** Burnt in by ffmpeg over this shot. The advertiser's words, not the model's. */
  caption: string | null;
};

export type CinematicBrief = {
  shots: CinematicShot[];
  /** Spoken over the whole spot. Advertiser-sourced facts live here safely. */
  voiceoverText: string;
  /** Rendered over the real photo at the end. */
  closingText: string;
  callToAction: string;
};

// Vendors meter per second and every shot is a separate billed generation, so
// an unbounded shot list is an unbounded invoice. Both ends matter: one long
// shot is cheap but reads as a screensaver, and eight short ones cost four
// times the plan's margin.
export const MIN_SHOT_SECONDS = 4;
export const MAX_SHOT_SECONDS = 8;
export const MAX_SHOTS = 4;

/** Seconds of the advertiser's real photo at the end. Free — we already have it. */
export const REAL_PHOTO_CLOSE_SECONDS = 3;

/**
 * Split the purchased seconds into shots.
 *
 * Deliberately derived from the paid `generatedSeconds` rather than taken from
 * the model's brief: if the number of shots were whatever Claude decided, a
 * chatty response would silently multiply the vendor bill on a fixed-price
 * product. The model chooses what is IN each shot; the price list chooses how
 * many there are.
 */
export function planShotDurations(generatedSeconds: number): number[] {
  const shots = Math.min(
    MAX_SHOTS,
    Math.max(1, Math.round(generatedSeconds / ((MIN_SHOT_SECONDS + MAX_SHOT_SECONDS) / 2))),
  );
  const base = Math.floor(generatedSeconds / shots);
  const durations = Array.from({ length: shots }, () => clampShot(base));
  // Give the remainder to the first shot — the opening is the one people
  // actually watch, and a 4s/4s/7s split reads better than 5s/5s/5s anyway.
  const assigned = durations.reduce((a, b) => a + b, 0);
  const remainder = generatedSeconds - assigned;
  if (remainder > 0) durations[0] = clampShot(durations[0] + remainder);
  return durations;
}

function clampShot(seconds: number): number {
  return Math.min(MAX_SHOT_SECONDS, Math.max(MIN_SHOT_SECONDS, seconds));
}

/** What the generation will actually cost us, before any retry. */
export function billedSeconds(shots: CinematicShot[]): number {
  return shots.reduce((total, shot) => total + shot.seconds, 0);
}

// ---------------------------------------------------------------------------
// The guardrail. This is the part of the file that matters.
//
// A generated visual is not evidence of anything. If the model films a
// glistening croissant for a bakery that sells rusks, the ad has made a claim
// about goods the shop does not sell — misleading advertising under India's
// ASCI code and the FTC's endorsement rules alike, and the advertiser carries
// it, not us. The same is true of a price: video models render on-screen text
// unreliably, so "20% OFF" comes out as "2O% 0FF" often enough that it cannot
// be allowed near a paid placement, and a WRONG price in an ad is worse than
// no price.
//
// So the division is absolute:
//
//   generated footage  ->  atmosphere only. Light, texture, hands, motion.
//   burnt-in captions  ->  every factual claim, rendered by ffmpeg from the
//                          advertiser's own words, pixel-exact and reviewable.
//   the real photo     ->  the proof that the business exists.
//
// Enforced here rather than in the Claude system prompt alone, because a system
// prompt is a request and this is a requirement.
// ---------------------------------------------------------------------------

/** Digits, currency and percentages: the three shapes a factual claim takes. */
const CLAIM_PATTERN = /[0-9]|%|₹|\$|£|€|\bfree\b|\boff\b|\bsale\b|\bdiscount\b/i;

/** Instructions to render words inside the frame, which we never allow. */
// Includes the SURFACES that imply rendered text, not just the word "text".
// A bakery prompt reaches for a chalkboard immediately, and a chalkboard in
// frame is a price board the model will fill in with garbled characters.
const ON_SCREEN_TEXT_PATTERN =
  /\b(text|caption|subtitle|title card|signage|sign reading|banner|poster|logo|watermark|writing|written|letters|words|chalkboard|blackboard|whiteboard|menu board|price ?board|price ?tag|price ?list|receipt|label)\b/i;

export type VisualRejection = { reason: "claim" | "on_screen_text"; match: string };

/**
 * Why a shot prompt cannot be used, or null when it is fine.
 *
 * Returns the offending substring so the caller can log what the model tried
 * to do — a model that keeps reaching for prices is a system-prompt bug, and
 * silently rewriting its output would hide that.
 */
export function rejectVisualPrompt(prompt: string): VisualRejection | null {
  const onScreen = prompt.match(ON_SCREEN_TEXT_PATTERN);
  if (onScreen) return { reason: "on_screen_text", match: onScreen[0] };
  const claim = prompt.match(CLAIM_PATTERN);
  if (claim) return { reason: "claim", match: claim[0] };
  return null;
}

export function isVisualPromptSafe(prompt: string): boolean {
  return rejectVisualPrompt(prompt) === null;
}

export type BriefRejection =
  | { reason: "no_shots" }
  | { reason: "too_many_shots"; count: number }
  | { reason: "no_real_photo" }
  | { reason: "over_budget"; billed: number; paid: number }
  | { reason: "unsafe_visual"; shotIndex: number; detail: VisualRejection };

/**
 * Everything that must hold before a single second is billed to a vendor.
 *
 * `realAssetCount` is passed in rather than inferred, because the rule it
 * enforces is the product's whole integrity claim: an ad made ENTIRELY of
 * generated footage is a stock-footage advertisement for a business that may as
 * well not exist. There is always a real photo, and it always closes.
 */
export function rejectBrief(args: {
  brief: CinematicBrief;
  addOn: AddOn;
  realAssetCount: number;
}): BriefRejection | null {
  const { brief, addOn, realAssetCount } = args;

  if (brief.shots.length === 0) return { reason: "no_shots" };
  if (brief.shots.length > MAX_SHOTS) {
    return { reason: "too_many_shots", count: brief.shots.length };
  }
  if (realAssetCount < 1) return { reason: "no_real_photo" };

  const billed = billedSeconds(brief.shots);
  if (billed > addOn.generatedSeconds) {
    return { reason: "over_budget", billed, paid: addOn.generatedSeconds };
  }

  for (const [shotIndex, shot] of brief.shots.entries()) {
    const detail = rejectVisualPrompt(shot.prompt);
    if (detail) return { reason: "unsafe_visual", shotIndex, detail };
  }

  return null;
}

/** Total runtime including the free real-photo close. */
export function totalDurationSeconds(brief: CinematicBrief): number {
  return billedSeconds(brief.shots) + REAL_PHOTO_CLOSE_SECONDS;
}

// ---------------------------------------------------------------------------
// Order lifecycle.
//
// Mirrors the subscription statuses on purpose. A one-off purchase has the same
// awkward middle as a recurring one — paid but not yet delivered — and the
// reason it needs its own state rather than "paid = done" is that generation
// happens minutes later in the renderer and can fail after the money is taken.
// ---------------------------------------------------------------------------

export const PURCHASE_STATUSES = [
  "pending", // checkout created, no money yet
  "paid", // money taken, generation not started
  "producing", // renderer has claimed it
  "delivered", // creative is ready
  "failed", // generation failed after payment — REFUNDABLE, see below
  "refunded",
  "cancelled", // abandoned before payment
] as const;
export type PurchaseStatus = (typeof PURCHASE_STATUSES)[number];

/** Paid for something they have not received. Nothing else is refundable. */
export function isRefundable(status: PurchaseStatus): boolean {
  return status === "paid" || status === "producing" || status === "failed";
}

/** Whether the renderer may pick this order up. */
export function isProducible(status: PurchaseStatus): boolean {
  return status === "paid";
}

// Generation is metered, so a retry loop is a spend loop. Three attempts is
// enough to ride out a vendor 5xx and not enough to burn the margin on a
// prompt the model will never satisfy.
export const MAX_PRODUCTION_ATTEMPTS = 3;

export function shouldRetryProduction(attempts: number): boolean {
  return attempts < MAX_PRODUCTION_ATTEMPTS;
}

/** Ledger refs, mirroring feeLedgerRefs() for subscriptions. */
export function purchaseLedgerRefs(purchaseId: string) {
  return { credit: `purchase:${purchaseId}`, fee: `purchase:${purchaseId}:fee` };
}

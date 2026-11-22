import { describe, expect, it } from "vitest";
import type { AdScript } from "../script/schema.js";
import {
  billingMonthOf,
  classifySwapReply,
  deterministicRecut,
  mergeRecut,
  needsBaseCut,
  nextSwapStep,
  offerBadge,
  offerChangeCharge,
  offerChangeStage,
  replacedAdAction,
  resolveEndsAt,
  scriptTexts,
  transcriptionAllowed,
  untilTag,
  validRecutText,
  BUTTON_APPROVE,
  BUTTON_REJECT,
  MAX_VOICE_BYTES,
  SLOW_REVIEW_HOURS,
} from "./policy.js";

const NOW = new Date("2026-11-21T12:00:00Z");

const BASE: AdScript = {
  hook: "Spotless homes, 20% off this month",
  scenes: [
    { assetIndex: 0, caption: "20% off deep cleans", durationSeconds: 4 },
    { assetIndex: 1, caption: "Sparkle Cleaning", durationSeconds: 4 },
    { assetIndex: 2, caption: "Book now", durationSeconds: 3 },
  ],
  callToAction: "Book now",
  endCardText: "Sparkle Cleaning",
  voiceoverText: "[cheerfully] Twenty percent off deep cleans this month at Sparkle Cleaning. Book now.",
  sticker: { badge: "20% OFF", headline: "DEEP CLEANS", tagline: "THIS MONTH ONLY", benefits: [] },
  voice: "Laura",
  photoMotions: [
    { assetIndex: 0, motion: "the cleaner wipes the counter" },
    { assetIndex: 1, motion: "slow dolly-in" },
  ],
  openerPrompt: "Morning light across a spotless kitchen counter, slow dolly-in over gleaming tiles",
  peopleIndexes: [0],
  badges: ["Licensed & insured"],
  endCardLine: "Move-out cleans",
};

describe("offerChangeCharge (one included a month, then $2)", () => {
  it("first change of the month is included on the plan, the next is $2", () => {
    expect(offerChangeCharge({ exempt: false, planIncludesChanges: true, includedUsedThisMonth: 0, priceMinor: 200 })).toEqual({
      charge: "included",
      amountMinor: 0,
      includedLeft: 1,
    });
    expect(offerChangeCharge({ exempt: false, planIncludesChanges: true, includedUsedThisMonth: 1, priceMinor: 200 })).toEqual({
      charge: "paid",
      amountMinor: 200,
      includedLeft: 0,
    });
  });
  it("no plan: every change is paid; admins / at_cost are exempt; test mode price is passed through", () => {
    expect(offerChangeCharge({ exempt: false, planIncludesChanges: false, includedUsedThisMonth: 0, priceMinor: 200 }).charge).toBe("paid");
    expect(offerChangeCharge({ exempt: true, planIncludesChanges: false, includedUsedThisMonth: 5, priceMinor: 200 })).toMatchObject({ charge: "exempt", amountMinor: 0 });
    expect(offerChangeCharge({ exempt: false, planIncludesChanges: true, includedUsedThisMonth: 1, priceMinor: 50 }).amountMinor).toBe(50);
  });
  it("counts by UTC calendar month", () => {
    expect(billingMonthOf(new Date("2026-11-30T23:59:59Z"))).toBe("2026-11-01");
    expect(billingMonthOf(new Date("2026-12-01T00:00:00Z"))).toBe("2026-12-01");
  });
});

describe("resolveEndsAt (always a date)", () => {
  it("uses the owner's date, end of that day UTC", () => {
    const r = resolveEndsAt({ offerText: "x", endsOn: "2026-12-05", now: NOW });
    expect(r).toEqual({ ok: true, endsAt: new Date("2026-12-05T23:59:59Z"), inferred: false });
  });
  it("refuses past, malformed and too-far dates", () => {
    expect(resolveEndsAt({ offerText: "x", endsOn: "2026-11-20", now: NOW })).toEqual({ ok: false, error: "ends_on_in_past" });
    expect(resolveEndsAt({ offerText: "x", endsOn: "2026-02-31", now: NOW })).toEqual({ ok: false, error: "ends_on_invalid" });
    expect(resolveEndsAt({ offerText: "x", endsOn: "2027-06-01", now: NOW })).toEqual({ ok: false, error: "ends_on_too_far" });
  });
  it("infers from the text, else end of month flagged as inferred", () => {
    const parsed = resolveEndsAt({ offerText: "$10 off till 28th", now: NOW });
    expect(parsed).toMatchObject({ ok: true, inferred: false });
    if (parsed.ok) expect(parsed.endsAt.toISOString().slice(0, 10)).toBe("2026-11-28");
    const guess = resolveEndsAt({ offerText: "$10 off any clean", now: NOW });
    expect(guess).toMatchObject({ ok: true, inferred: true });
    if (guess.ok) expect(guess.endsAt.toISOString()).toBe("2026-11-30T23:59:59.000Z");
  });
});

describe("nextSwapStep (the swap state machine)", () => {
  const f = (over: Partial<Parameters<typeof nextSwapStep>[0]>) =>
    nextSwapStep({ kind: "offer", status: "rendering", rendersReady: false, renderFailed: false, uploaded: false, uploadFailed: false, now: NOW, ...over });

  it("rendering -> preview (offer) or straight to publishing (base); failed render fails", () => {
    expect(f({})).toBe("wait");
    expect(f({ rendersReady: true })).toBe("preview_ready");
    expect(f({ kind: "base", rendersReady: true })).toBe("park_base");
    expect(f({ renderFailed: true, rendersReady: false })).toBe("render_failed");
  });
  it("publishing -> add the NEW ad once every cut is on YouTube", () => {
    expect(f({ status: "publishing" })).toBe("wait");
    expect(f({ status: "publishing", uploaded: true })).toBe("add_to_google");
    expect(f({ status: "publishing", uploaded: true, kind: "base" })).toBe("park_base");
    expect(f({ status: "publishing", uploadFailed: true })).toBe("upload_failed");
  });
  it("approve-then-remove: only an approved new ad is promoted; disapproval keeps the old", () => {
    expect(f({ status: "pending_google", googlePolicy: "under_review", googleAddedAt: NOW })).toBe("wait");
    expect(f({ status: "pending_google", googlePolicy: "approved" })).toBe("promote");
    expect(f({ status: "pending_google", googlePolicy: "approved_limited" })).toBe("promote");
    expect(f({ status: "pending_google", googlePolicy: "disapproved" })).toBe("disapproved");
  });
  it("a slow review pages ops once", () => {
    const old = new Date(NOW.getTime() - (SLOW_REVIEW_HOURS + 1) * 3_600_000);
    expect(f({ status: "pending_google", googlePolicy: "under_review", googleAddedAt: old })).toBe("alert_slow_review");
    expect(f({ status: "pending_google", googlePolicy: "under_review", googleAddedAt: old, opsAlertedAt: NOW })).toBe("wait");
  });
  it("live offer: back to base at the end date, never before; a live base just waits", () => {
    expect(f({ status: "live", endsAt: new Date(NOW.getTime() + 1000) })).toBe("wait");
    expect(f({ status: "live", endsAt: NOW })).toBe("restore_base");
    expect(f({ status: "live", kind: "base", endsAt: null })).toBe("wait");
  });
  it("the replaced ad: the base / launch ad is paused, an old offer's ad removed", () => {
    expect(replacedAdAction("customers/1/adGroupAds/2~3", "customers/1/adGroupAds/2~3")).toBe("pause");
    expect(replacedAdAction("customers/1/adGroupAds/2~4", "customers/1/adGroupAds/2~3")).toBe("remove");
    expect(replacedAdAction(null, null)).toBe("none");
  });
  it("stage words for the page", () => {
    expect(offerChangeStage("rendering")).toBe("making");
    expect(offerChangeStage("pending_google")).toBe("waiting_google");
    expect(offerChangeStage("ended")).toBe("back_to_base");
  });
});

describe("the base ad", () => {
  it("a launch ad with an offer (or unknown inputs) needs a no-offer base cut", () => {
    expect(needsBaseCut({ offerDetails: "20% off" })).toBe(true);
    expect(needsBaseCut(null)).toBe(true);
    expect(needsBaseCut({ offerDetails: "  " })).toBe(false);
    expect(needsBaseCut({ offerDetails: null })).toBe(false);
  });
});

describe("the re-cut script keeps everything that costs money", () => {
  const frozen = (s: AdScript) => ({
    scenes: s.scenes.map(({ assetIndex, durationSeconds }) => ({ assetIndex, durationSeconds })),
    photoMotions: s.photoMotions,
    openerPrompt: s.openerPrompt,
    voice: s.voice,
    peopleIndexes: s.peopleIndexes,
    badges: s.badges,
    endCardLine: s.endCardLine,
    callToAction: s.callToAction,
  });

  it("deterministic offer re-cut: the owner's price on the sticker, the end date as tag", () => {
    const endsAt = new Date("2026-12-15T23:59:59Z");
    const s = deterministicRecut({ base: BASE, offer: "$25 off any move-out clean. Book by Dec 15.", endsAt, businessName: "Sparkle Cleaning", businessCategory: "Cleaning", callToAction: "Book now" });
    expect(frozen(s)).toEqual(frozen(BASE));
    expect(s.sticker).toMatchObject({ badge: "$25 OFF", tagline: "UNTIL DEC 15" });
    expect(s.hook).toContain("$25 off");
    expect(s.scenes[0]!.caption).toContain("$25 off");
    expect(s.voiceoverText.startsWith("[cheerfully]")).toBe(true);
    expect(scriptTexts(s).join(" ")).not.toMatch(/20%/);
  });
  it("deterministic BASE cut has no offer anywhere", () => {
    const s = deterministicRecut({ base: BASE, offer: null, endsAt: null, businessName: "Sparkle Cleaning", businessCategory: "Cleaning", callToAction: "Book now" });
    expect(frozen(s)).toEqual(frozen(BASE));
    expect(scriptTexts(s).join(" ")).not.toMatch(/%|\$|off\b|month only/i);
    expect(s.sticker?.badge).toBe("LOCAL");
  });
  it("a model edit is fitted to the limits and cannot change scenes or photos", () => {
    const s = mergeRecut(BASE, {
      hook: "x".repeat(200),
      captions: ["New caption one", "Two", "Three", "extra ignored"],
      endCardText: "Sparkle",
      voiceoverText: "[cheerfully] New words.",
      sticker: { badge: "fifteen percent off", headline: "h", tagline: "t", benefits: ["a", "b", "c"] },
    });
    expect(s.hook.length).toBeLessThanOrEqual(80);
    expect(s.scenes).toHaveLength(3);
    expect(s.sticker!.badge.length).toBeLessThanOrEqual(10);
    expect(s.sticker!.benefits).toHaveLength(2);
    expect(frozen(s)).toEqual(frozen(BASE));
  });
  it("validRecutText checks the caption count and shape", () => {
    const ok = { hook: "h", captions: ["a", "b", "c"], endCardText: "e", voiceoverText: "v", sticker: { badge: "b", headline: "h", tagline: "t", benefits: [] } };
    expect(validRecutText(ok, 3)).toBe(true);
    expect(validRecutText({ ...ok, captions: ["a"] }, 3)).toBe(false);
    expect(validRecutText({ ...ok, hook: "" }, 3)).toBe(false);
    expect(validRecutText(null, 3)).toBe(false);
  });
  it("offerBadge only repeats what the owner typed", () => {
    expect(offerBadge("30% off colouring")).toBe("30% OFF");
    expect(offerBadge("Haircuts $19 this week")).toBe("$19");
    expect(offerBadge("Free estimate")).toBe("FREE");
    expect(offerBadge("Same-day service")).toBeNull();
    expect(untilTag(new Date("2026-01-05T23:59:59Z"))).toBe("UNTIL JAN 5");
  });
});

describe("WhatsApp replies (text / photo / voice / YES)", () => {
  it("text is an offer while nothing waits, YES approves a preview", () => {
    expect(classifySwapReply({ kind: "text", text: "$10 off any clean till Dec 5" }, false)).toEqual({ intent: "offer", text: "$10 off any clean till Dec 5" });
    expect(classifySwapReply({ kind: "text", text: "yes" }, false)).toEqual({ intent: "unclear" });
    expect(classifySwapReply({ kind: "text", text: "YES" }, true)).toEqual({ intent: "approve" });
    expect(classifySwapReply({ kind: "text", text: "haan" }, true)).toEqual({ intent: "approve" });
    expect(classifySwapReply({ kind: "text", text: "no" }, true)).toEqual({ intent: "reject" });
    expect(classifySwapReply({ kind: "text", text: "make it 15% instead" }, true)).toEqual({ intent: "offer", text: "make it 15% instead" });
  });
  it("buttons, photos and voice notes", () => {
    expect(classifySwapReply({ kind: "button", buttonId: BUTTON_APPROVE }, true)).toEqual({ intent: "approve" });
    expect(classifySwapReply({ kind: "button", buttonId: BUTTON_APPROVE }, false)).toEqual({ intent: "unclear" });
    expect(classifySwapReply({ kind: "button", buttonId: BUTTON_REJECT }, true)).toEqual({ intent: "reject" });
    expect(classifySwapReply({ kind: "image", text: "New kitchen photo" }, false)).toEqual({ intent: "photo", caption: "New kitchen photo" });
    expect(classifySwapReply({ kind: "audio" }, false)).toEqual({ intent: "voice" });
  });
  it("speech to text has hard caps", () => {
    expect(transcriptionAllowed({ bytes: 50_000, usedToday: 0 })).toBe(true);
    expect(transcriptionAllowed({ bytes: MAX_VOICE_BYTES + 1, usedToday: 0 })).toBe(false);
    expect(transcriptionAllowed({ bytes: 50_000, seconds: 300, usedToday: 0 })).toBe(false);
    expect(transcriptionAllowed({ bytes: 50_000, usedToday: 6 })).toBe(false);
    expect(transcriptionAllowed({ bytes: 0, usedToday: 0 })).toBe(false);
  });
});

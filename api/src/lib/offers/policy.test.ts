import { describe, expect, it } from "vitest";
import {
  classifyReply,
  endOfMonth,
  inferOfferExpiry,
  MAX_REMINDERS,
  nextCycleAction,
} from "./policy.js";

const utc = (s: string) => new Date(s);

describe("classifyReply", () => {
  it("reads a bare yes while waiting for the offer as content-free, not as the offer", () => {
    // Otherwise the ad's script becomes the word "yes".
    expect(classifyReply("yes", "prompted")).toEqual({ intent: "unclear" });
  });

  it("reads a yes after a preview as approval to publish", () => {
    expect(classifyReply("yes", "previewed")).toEqual({ intent: "approve" });
  });

  it("understands Hinglish affirmatives", () => {
    // An English-only list would treat these as ad copy and render an ad whose
    // script is the word "haan".
    for (const yes of ["haan", "Haan", "ji", "theek hai", "sahi"]) {
      expect(classifyReply(yes, "previewed").intent).toBe("approve");
    }
  });

  it("understands a thumbs-up as approval", () => {
    expect(classifyReply("👍", "previewed").intent).toBe("approve");
  });

  it("treats an unreadable reply after a preview as a revision, never as a yes", () => {
    // Publishing someone's advertising on the strength of a message we could
    // not parse is the worst failure available here.
    const result = classifyReply("actually make it 40%", "previewed");
    expect(result.intent).toBe("offer");
  });

  it("captures an offer verbatim", () => {
    expect(classifyReply("30% off colouring till 15th", "prompted")).toEqual({
      intent: "offer",
      text: "30% off colouring till 15th",
    });
  });

  it("ignores greetings and stray taps", () => {
    expect(classifyReply("hi", "prompted").intent).toBe("unclear");
    expect(classifyReply("   ", "prompted").intent).toBe("unclear");
  });

  it("recognises a refusal in either language", () => {
    expect(classifyReply("nahi", "prompted").intent).toBe("reject");
    expect(classifyReply("stop", "previewed").intent).toBe("reject");
  });

  it("tolerates trailing punctuation", () => {
    expect(classifyReply("yes!", "previewed").intent).toBe("approve");
  });
});

describe("inferOfferExpiry", () => {
  const now = utc("2026-08-03T00:00:00Z"); // a Monday

  it("always returns a date, even when nothing parses", () => {
    // This is the property that matters. An offer with no deadline runs
    // forever, and a Diwali special serving in December is worse than no ad.
    const r = inferOfferExpiry("buy one get one free", now);
    expect(r.parsed).toBe(false);
    expect(r.expiresAt.toISOString()).toBe(endOfMonth(now).toISOString());
  });

  it("reads 'till 15th' as the 15th of this month", () => {
    const r = inferOfferExpiry("30% off till 15th", now);
    expect(r.parsed).toBe(true);
    expect(r.expiresAt.toISOString().slice(0, 10)).toBe("2026-08-15");
  });

  it("rolls a day already past into next month", () => {
    const r = inferOfferExpiry("offer till 1st", utc("2026-08-20T00:00:00Z"));
    expect(r.expiresAt.toISOString().slice(0, 10)).toBe("2026-09-01");
  });

  it("reads an explicit date and month", () => {
    const r = inferOfferExpiry("flat 500 off, valid 20 Aug", now);
    expect(r.parsed).toBe(true);
    expect(r.expiresAt.toISOString().slice(0, 10)).toBe("2026-08-20");
  });

  it("reads a weekday as the next such day", () => {
    const r = inferOfferExpiry("free head massage till Sunday", now);
    expect(r.parsed).toBe(true);
    expect(r.expiresAt.getUTCDay()).toBe(0);
    expect(r.expiresAt.toISOString().slice(0, 10)).toBe("2026-08-09");
  });

  it("reads 'this weekend' as through Sunday", () => {
    const r = inferOfferExpiry("special this weekend", now);
    expect(r.expiresAt.toISOString().slice(0, 10)).toBe("2026-08-09");
  });

  it("expires at the END of the stated day, so the offer's last day still runs", () => {
    const r = inferOfferExpiry("till 15th", now);
    expect(r.expiresAt.getUTCHours()).toBe(23);
  });
});

describe("nextCycleAction", () => {
  const promptedAt = utc("2026-08-01T00:00:00Z");

  it("prompts a pending cycle", () => {
    expect(
      nextCycleAction({ status: "pending", promptedAt: null, reminderCount: 0, now: promptedAt }),
    ).toEqual({ action: "prompt" });
  });

  it("waits before the first reminder is due", () => {
    expect(
      nextCycleAction({
        status: "prompted",
        promptedAt,
        reminderCount: 0,
        now: utc("2026-08-02T00:00:00Z"),
      }),
    ).toEqual({ action: "wait" });
  });

  it("reminds once the gap has passed", () => {
    expect(
      nextCycleAction({
        status: "prompted",
        promptedAt,
        reminderCount: 0,
        now: utc("2026-08-05T00:00:00Z"),
      }),
    ).toEqual({ action: "remind", reminderNumber: 1 });
  });

  it("stops reminding after the cap", () => {
    // A shop owner who feels nagged reports the number, and enough reports cost
    // the WhatsApp business account itself — the whole channel, not one
    // customer.
    expect(
      nextCycleAction({
        status: "prompted",
        promptedAt,
        reminderCount: MAX_REMINDERS,
        now: utc("2026-08-10T00:00:00Z"),
      }),
    ).toEqual({ action: "wait" });
  });

  it("gives up entirely after the skip window", () => {
    expect(
      nextCycleAction({
        status: "prompted",
        promptedAt,
        reminderCount: MAX_REMINDERS,
        now: utc("2026-08-20T00:00:00Z"),
      }),
    ).toEqual({ action: "skip" });
  });

  it("stops chasing as soon as the owner engages", () => {
    for (const status of ["answered", "previewed", "approved", "skipped"] as const) {
      expect(
        nextCycleAction({ status, promptedAt, reminderCount: 0, now: utc("2026-08-30T00:00:00Z") }),
      ).toEqual({ action: "wait" });
    }
  });
});

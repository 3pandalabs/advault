import { describe, expect, it } from "vitest";
import { addOnFor } from "../pricing/index.js";
import {
  MAX_SHOT_SECONDS,
  MIN_SHOT_SECONDS,
  billedSeconds,
  isRefundable,
  planShotDurations,
  rejectBrief,
  rejectVisualPrompt,
  shouldRetryProduction,
  totalDurationSeconds,
  type CinematicBrief,
} from "./policy.js";

const addOn = addOnFor("INR", "cinematic");

function brief(overrides: Partial<CinematicBrief> = {}): CinematicBrief {
  return {
    shots: [
      { prompt: "Warm morning light through a bakery window, steam rising", seconds: 5, caption: null },
      { prompt: "Close on flour-dusted hands folding dough, shallow depth of field", seconds: 5, caption: null },
      { prompt: "Slow dolly across a wooden counter, golden hour", seconds: 5, caption: null },
    ],
    voiceoverText: "Twenty percent off all August at Sharma Bakery.",
    closingText: "Sharma Bakery",
    callToAction: "Visit us",
    ...overrides,
  };
}

describe("planShotDurations", () => {
  it("never exceeds the seconds that were paid for", () => {
    // The vendor bill is per second. If this could round up, a fixed-price
    // product would have a variable cost.
    for (const paid of [8, 12, 15, 20, 24]) {
      const durations = planShotDurations(paid);
      expect(durations.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(paid);
    }
  });

  it("keeps every shot within the vendor's usable range", () => {
    for (const paid of [8, 12, 15, 20, 24]) {
      for (const seconds of planShotDurations(paid)) {
        expect(seconds).toBeGreaterThanOrEqual(MIN_SHOT_SECONDS);
        expect(seconds).toBeLessThanOrEqual(MAX_SHOT_SECONDS);
      }
    }
  });

  it("gives the remainder to the opening shot", () => {
    // The first shot is the one people actually watch; an uneven split should
    // favour it rather than trailing off at the end.
    const durations = planShotDurations(15);
    expect(durations[0]).toBeGreaterThanOrEqual(durations[durations.length - 1]);
  });
});

describe("rejectVisualPrompt", () => {
  // The whole legal position of this product rests on these four tests. A
  // generated visual is not evidence, so it may never carry a claim.

  it("rejects a price in the generated footage", () => {
    const rejection = rejectVisualPrompt("A croissant beside a chalkboard showing ₹99");
    expect(rejection?.reason).toBe("on_screen_text");
  });

  it("rejects a percentage claim", () => {
    expect(rejectVisualPrompt("Golden pastries, 20% off banner")).not.toBeNull();
  });

  it("rejects any instruction to render words inside the frame", () => {
    // Video models render text unreliably. "20% OFF" comes back as "2O% 0FF"
    // often enough that it cannot go near a paid placement.
    for (const prompt of [
      "A shopfront with signage reading Sharma Bakery",
      "Steam rising, with a caption over the top",
      "A poster on the wall",
    ]) {
      expect(rejectVisualPrompt(prompt)).not.toBeNull();
    }
  });

  it("allows pure atmosphere", () => {
    for (const prompt of [
      "Warm morning light through a bakery window, steam rising",
      "Close on flour-dusted hands folding dough, shallow depth of field",
      "Slow dolly across a wooden counter, golden hour",
    ]) {
      expect(rejectVisualPrompt(prompt)).toBeNull();
    }
  });

  it("lets facts through in the voiceover and captions, which ffmpeg renders exactly", () => {
    // The claim isn't banned from the ad — it is banned from the GENERATED
    // part of it. Captions are burnt in from the advertiser's own words.
    const rejection = rejectBrief({ brief: brief(), addOn, realAssetCount: 1 });
    expect(rejection).toBeNull();
    expect(brief().voiceoverText).toContain("Twenty percent off");
  });
});

describe("rejectBrief", () => {
  it("refuses an ad made entirely of generated footage", () => {
    // Without a real photo this is a stock-footage advertisement for a business
    // that may as well not exist. The photo is the only proof the shop is real.
    expect(rejectBrief({ brief: brief(), addOn, realAssetCount: 0 })).toEqual({
      reason: "no_real_photo",
    });
  });

  it("refuses to bill more seconds than were purchased", () => {
    const greedy = brief({
      shots: [
        { prompt: "Warm light on a counter", seconds: 8, caption: null },
        { prompt: "Hands folding dough slowly", seconds: 8, caption: null },
        { prompt: "Golden hour across the room", seconds: 8, caption: null },
      ],
    });
    const rejection = rejectBrief({ brief: greedy, addOn, realAssetCount: 1 });
    expect(rejection).toMatchObject({ reason: "over_budget", billed: 24, paid: 15 });
  });

  it("names which shot was unsafe rather than failing the whole brief anonymously", () => {
    const unsafe = brief({
      shots: [
        { prompt: "Warm light on a counter", seconds: 5, caption: null },
        { prompt: "A banner showing the offer", seconds: 5, caption: null },
      ],
    });
    expect(rejectBrief({ brief: unsafe, addOn, realAssetCount: 2 })).toMatchObject({
      reason: "unsafe_visual",
      shotIndex: 1,
    });
  });

  it("accepts a well-formed brief", () => {
    expect(rejectBrief({ brief: brief(), addOn, realAssetCount: 2 })).toBeNull();
  });
});

describe("duration and spend", () => {
  it("bills only the generated seconds, never the advertiser's own photo", () => {
    const b = brief();
    expect(billedSeconds(b.shots)).toBe(15);
    expect(totalDurationSeconds(b)).toBe(18);
  });
});

describe("refunds and retries", () => {
  it("treats a failure AFTER payment as refundable", () => {
    // Money taken, nothing delivered. This is the state that must never be
    // silently terminal.
    expect(isRefundable("failed")).toBe(true);
    expect(isRefundable("paid")).toBe(true);
  });

  it("does not offer a refund for something never paid for or already delivered", () => {
    expect(isRefundable("pending")).toBe(false);
    expect(isRefundable("cancelled")).toBe(false);
    expect(isRefundable("delivered")).toBe(false);
  });

  it("stops retrying before the retries cost more than the sale", () => {
    expect(shouldRetryProduction(0)).toBe(true);
    expect(shouldRetryProduction(2)).toBe(true);
    expect(shouldRetryProduction(3)).toBe(false);
  });
});

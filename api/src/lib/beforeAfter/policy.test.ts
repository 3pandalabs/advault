import { describe, expect, it } from "vitest";
import {
  BEFORE_AFTER_CATEGORIES,
  beforeAfterAllowed,
  beforeAfterInputSchema,
  beforeAfterViolation,
  pairAssetIds,
  plainPhotoIndexes,
  withoutPairPhotos,
} from "./policy.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const D = "44444444-4444-4444-8444-444444444444";

describe("beforeAfterAllowed", () => {
  it("allows every trade preset in the list", () => {
    for (const c of BEFORE_AFTER_CATEGORIES) expect(beforeAfterAllowed(c)).toBe(true);
  });

  it("hides it for the wizard's other presets", () => {
    for (const c of ["Dentistry", "Restaurant", "Real estate", "Other", ""]) expect(beforeAfterAllowed(c)).toBe(false);
    expect(beforeAfterAllowed(null)).toBe(false);
  });

  it("allows typed-in trades", () => {
    for (const c of [
      "Roofing",
      "House painting",
      "Painter",
      "General contractor",
      "Kitchen remodeling",
      "Lawn care",
      "Pressure washing",
      "Power washing",
      "Auto detailing",
      "Body shop",
      "Auto body & collision",
      "Flooring",
      "Junk removal",
      "Fence installation",
      "Handyman",
      "Carpet cleaning",
      "Auto repair shop",
    ]) {
      expect(beforeAfterAllowed(c), c).toBe(true);
    }
  });

  it("never for health, cosmetic or body-related businesses, even with a trade word", () => {
    for (const c of [
      "Med spa",
      "Hair salon",
      "Barbershop",
      "Nail salon",
      "Teeth whitening",
      "Dental clinic",
      "Cosmetic surgery",
      "Skin care",
      "Laser hair removal",
      "Fitness coach",
      "Personal training",
      "Weight loss clinic",
      "Tattoo studio",
      "Massage therapy",
      "Chiropractor",
      "Pet grooming",
      "Teeth cleaning",
      "Bath & Body shop",
    ]) {
      expect(beforeAfterAllowed(c), c).toBe(false);
    }
  });

  it("never for food, retail or real estate", () => {
    for (const c of ["Bakery", "Coffee shop", "Kitchen & Bar", "Clothing boutique", "Realtor", "Real estate painting"]) {
      expect(beforeAfterAllowed(c), c).toBe(false);
    }
  });
});

describe("beforeAfterViolation", () => {
  const one = [{ beforeAssetId: A, afterAssetId: B }];

  it("an empty list is always fine (it removes them)", () => {
    expect(beforeAfterViolation("Dentistry", { pairs: [] })).toBeNull();
  });

  it("needs an allowed category", () => {
    expect(beforeAfterViolation("Hair salon", { pairs: one, attested: true })).toBe("before_after_not_for_category");
  });

  it("needs the attestation tick", () => {
    expect(beforeAfterViolation("Roofing", { pairs: one })).toBe("before_after_attestation_required");
    expect(beforeAfterViolation("Roofing", { pairs: one, attested: false })).toBe("before_after_attestation_required");
    expect(beforeAfterViolation("Roofing", { pairs: one, attested: true })).toBeNull();
  });

  it("refuses the same photo twice", () => {
    expect(beforeAfterViolation("Roofing", { pairs: [{ beforeAssetId: A, afterAssetId: A }], attested: true })).toBe(
      "before_after_same_photo",
    );
    expect(
      beforeAfterViolation("Roofing", {
        pairs: [
          { beforeAssetId: A, afterAssetId: B },
          { beforeAssetId: B, afterAssetId: C },
        ],
        attested: true,
      }),
    ).toBe("before_after_duplicate_photo");
  });

  it("the schema caps it at two pairs of uuids", () => {
    const pairs = [
      { beforeAssetId: A, afterAssetId: B },
      { beforeAssetId: C, afterAssetId: D },
    ];
    expect(beforeAfterInputSchema.safeParse({ pairs, attested: true }).success).toBe(true);
    expect(beforeAfterInputSchema.safeParse({ pairs: [...pairs, pairs[0]], attested: true }).success).toBe(false);
    expect(beforeAfterInputSchema.safeParse({ pairs: [{ beforeAssetId: "x", afterAssetId: B }] }).success).toBe(false);
    expect(beforeAfterInputSchema.safeParse({ pairs: [{ beforeAssetId: A }] }).success).toBe(false);
  });
});

describe("the no-AI rule for pair photos", () => {
  it("every pair photo is left plain (no enhance, no motion)", () => {
    const keys = ["u/1.jpg", "u/before.jpg", "u/2.jpg", "u/after.jpg"];
    expect(plainPhotoIndexes(keys, [{ beforeKey: "u/before.jpg", afterKey: "u/after.jpg" }])).toEqual([1, 3]);
  });

  it("nothing is skipped without pairs", () => {
    expect(plainPhotoIndexes(["a.jpg", "b.jpg"], undefined)).toEqual([]);
    expect(plainPhotoIndexes(["a.jpg", "b.jpg"], [])).toEqual([]);
  });

  it("pair photos are kept out of the ad's ordinary photos", () => {
    const pairs = [{ beforeAssetId: A, afterAssetId: B }];
    expect(withoutPairPhotos([C, A, D, B], pairs)).toEqual([C, D]);
    expect(pairAssetIds(pairs)).toEqual([A, B]);
    expect(withoutPairPhotos([C, D], null)).toEqual([C, D]);
  });
});

describe("the script writer is told about the pairs", async () => {
  const { buildAdScriptUserPrompt, AD_SCRIPT_SYSTEM_PROMPT } = await import("../script/prompt.js");
  const { adScriptSchema } = await import("../script/schema.js");
  const input = {
    businessName: "Top Roofing",
    businessCategory: "Roofing",
    callToAction: "Call now",
    targetZipCodes: ["08817"],
    radiusMiles: 10,
    aspectRatio: "9:16" as const,
    assetCount: 3,
  };

  it("names them in the user turn only when there are some", () => {
    expect(buildAdScriptUserPrompt({ ...input, beforeAfterPairs: 2 })).toMatch(/Before & after: 2 pairs .*claim nothing specific/);
    expect(buildAdScriptUserPrompt(input)).not.toMatch(/Before & after/);
  });

  it("the system prompt forbids specific claims about them", () => {
    expect(AD_SCRIPT_SYSTEM_PROMPT).toMatch(/from this\.\.\. to this/);
    expect(AD_SCRIPT_SYSTEM_PROMPT).toMatch(/must not claim anything about that job/);
  });

  it("the script carries at most two pairs of keys", () => {
    const base = {
      hook: "Top Roofing",
      scenes: [
        { assetIndex: 0, caption: "Roofs", durationSeconds: 4 },
        { assetIndex: 1, caption: "Call", durationSeconds: 4 },
      ],
      callToAction: "Call now",
      endCardText: "Top Roofing",
      voiceoverText: "[warmly] Top Roofing.",
    };
    const pair = { beforeKey: "a.jpg", afterKey: "b.jpg" };
    expect(adScriptSchema.parse({ ...base, beforeAfter: [pair] }).beforeAfter).toEqual([pair]);
    expect(adScriptSchema.safeParse({ ...base, beforeAfter: [pair, pair, pair] }).success).toBe(false);
  });
});

describe("the web mirror (web/src/lib/beforeAfter.ts)", () => {
  it("has the same category rules, word for word", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const api = readFileSync(join(__dirname, "policy.ts"), "utf8");
    const web = readFileSync(join(__dirname, "../../../../web/src/lib/beforeAfter.ts"), "utf8");
    const core = api.slice(api.indexOf("export const MAX_BEFORE_AFTER_PAIRS"), api.indexOf("export const beforeAfterPairSchema")).trim();
    expect(core.length).toBeGreaterThan(500);
    expect(web.replace(/\r\n/g, "\n")).toContain(core.replace(/\r\n/g, "\n"));
  });
});

// Per-category facts the owner confirmed (badges, makes, a featured dish)
// reach the script writer, and attested badges survive only as AdVault sets
// them (lib/categories).
import { describe, expect, it } from "vitest";
import { buildAdScriptUserPrompt } from "./prompt.js";
import { adScriptSchema } from "./schema.js";

const base = {
  businessName: "Ace Plumbing",
  businessCategory: "Plumbing",
  callToAction: "Call now",
  targetZipCodes: ["08817"],
  radiusMiles: 10,
  aspectRatio: "16:9" as const,
  assetCount: 3,
};

describe("confirmedFacts in the prompt", () => {
  it("lists them as the advertiser's own facts", () => {
    const p = buildAdScriptUserPrompt({ ...base, confirmedFacts: ["Licensed & insured", "24/7 emergency service (you answer at night)"] });
    expect(p).toContain("Facts the advertiser confirmed are true");
    expect(p).toContain("- Licensed & insured");
  });

  it("says nothing when there are none", () => {
    expect(buildAdScriptUserPrompt({ ...base, confirmedFacts: [] })).not.toContain("confirmed are true");
    expect(buildAdScriptUserPrompt(base)).not.toContain("confirmed are true");
  });
});

describe("script badges", () => {
  const script = {
    hook: "Leaky pipe?",
    scenes: [
      { assetIndex: 0, caption: "a", durationSeconds: 3 },
      { assetIndex: 1, caption: "b", durationSeconds: 3 },
    ],
    callToAction: "Call now",
    endCardText: "Ace Plumbing",
    voiceoverText: "Call Ace.",
  };

  it("up to four short chips", () => {
    expect(adScriptSchema.parse({ ...script, badges: ["Licensed & insured"] }).badges).toEqual(["Licensed & insured"]);
    expect(adScriptSchema.safeParse({ ...script, badges: ["a", "b", "c", "d", "e"] }).success).toBe(false);
    expect(adScriptSchema.safeParse({ ...script, badges: ["x".repeat(29)] }).success).toBe(false);
  });
});

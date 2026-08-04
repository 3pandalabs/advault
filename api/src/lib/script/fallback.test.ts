import { describe, expect, it } from "vitest";
import { buildFallbackScript } from "./fallback.js";

const base = {
  businessName: "Sharma Salon",
  businessCategory: "Hair salon",
  callToAction: "Call now",
  targetZipCodes: ["560001"],
  assetCount: 2,
};

describe("buildFallbackScript", () => {
  it("never puts a raw postcode in front of the viewer", () => {
    // The bug this exists to prevent: the first template said "Looking for
    // Software studio near 94107?" on screen twice and once in the voiceover.
    // Nobody says a postcode out loud.
    const script = buildFallbackScript({ ...base, offerDetails: null });
    const everything = [
      script.hook,
      script.voiceoverText,
      script.endCardText,
      ...script.scenes.map((s) => s.caption),
    ].join(" ");
    expect(everything).not.toContain("560001");
  });

  it("leads with the advertiser's offer when there is one", () => {
    // The offer IS the ad. Ignoring it was the single biggest weakness of the
    // original template — the most persuasive input was dropped on the floor.
    const script = buildFallbackScript({
      ...base,
      offerDetails: "30% off colouring till the 15th",
    });
    expect(script.hook).toContain("30% off colouring");
    expect(script.voiceoverText).toContain("30% off colouring");
  });

  it("shortens a long offer on a word boundary, not mid-word", () => {
    const script = buildFallbackScript({
      ...base,
      offerDetails:
        "Five live products built and shipped in under a year, from idea to launched in weeks rather than quarters",
    });
    expect(script.hook.length).toBeLessThanOrEqual(60);
    expect(script.hook.endsWith(" ")).toBe(false);
    // A trailing partial word would mean the boundary logic failed.
    expect(script.hook).not.toMatch(/\s\S{1,2}$/);
  });

  it("still produces a usable script with no offer at all", () => {
    const script = buildFallbackScript({ ...base, offerDetails: null });
    expect(script.hook).toContain("Sharma Salon");
    expect(script.scenes.length).toBeGreaterThanOrEqual(2);
    expect(script.callToAction).toBe("Call now");
  });

  it("never points a scene at an asset index that does not exist", () => {
    const script = buildFallbackScript({ ...base, assetCount: 1, offerDetails: "Buy one get one" });
    for (const scene of script.scenes) {
      expect(scene.assetIndex).toBeLessThan(1);
    }
  });

  it("makes two businesses in the same area produce different ads", () => {
    // The failure the original template had: a salon and a dentist in one PIN
    // code got near-identical videos with the nouns swapped.
    const salon = buildFallbackScript({ ...base, offerDetails: "30% off colouring till Sunday" });
    const dentist = buildFallbackScript({
      ...base,
      businessName: "Kumar Dental",
      businessCategory: "Dentist",
      offerDetails: "Free consultation this month",
    });
    expect(salon.hook).not.toBe(dentist.hook);
    expect(salon.voiceoverText).not.toBe(dentist.voiceoverText);
  });
});

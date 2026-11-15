import { describe, expect, it } from "vitest";
import { adScriptSchema, cleanOpener, defaultVoiceFor, normalizeScriptJson } from "./schema.js";

const base = {
  hook: "Bright Smile Dental, on Park Avenue",
  scenes: [
    { assetIndex: 0, caption: "New patient exam", durationSeconds: 4 },
    { assetIndex: 1, caption: "Call to book", durationSeconds: 4 },
  ],
  callToAction: "Call now",
  endCardText: "Bright Smile Dental",
  voiceoverText: "[warmly] Bright Smile Dental. Call to book today!",
};

describe("demo-look script fields", () => {
  it("keeps a valid voice and per-photo motions", () => {
    const s = adScriptSchema.parse(
      normalizeScriptJson({
        ...base,
        voice: "Chris",
        photoMotions: [{ assetIndex: 1, motion: "The dentist keeps talking; slow gentle push-in." }],
      }),
    );
    expect(s.voice).toBe("Chris");
    expect(s.photoMotions?.[0].assetIndex).toBe(1);
  });

  it("drops an unknown voice and bad motion entries instead of failing the script", () => {
    const s = adScriptSchema.parse(
      normalizeScriptJson({
        ...base,
        voice: "Morgan",
        photoMotions: [{ assetIndex: 9, motion: "x" }, { assetIndex: 0, motion: "" }, { assetIndex: 0, motion: "a".repeat(400) }],
      }),
    );
    expect(s.voice).toBeUndefined();
    expect(s.photoMotions).toHaveLength(1);
    expect(s.photoMotions?.[0].motion).toHaveLength(300);
  });

  it("picks a voice by category", () => {
    expect(defaultVoiceFor("Real estate")).toBe("Chris");
    expect(defaultVoiceFor("Hair salon")).toBe("Laura");
    expect(defaultVoiceFor("Bakery")).toBe("Jessica");
    expect(defaultVoiceFor("Dentistry")).toBe("Sarah");
  });
});

describe("mixed ad opener prompt (2026-11-14)", () => {
  it("keeps a mood-only opener", () => {
    const p = "Warm morning light across empty styling chairs, steam curling from a cup, slow push-in, shallow depth of field.";
    expect(cleanOpener(p)).toBe(p);
  });

  it("drops an opener that would film a claim or text", () => {
    expect(cleanOpener("A chalkboard by the door reading fresh cuts today, warm light")).toBeUndefined();
    expect(cleanOpener("Golden light over the counter, 20% off everything")).toBeUndefined();
  });

  it("drops empty or too-short openers", () => {
    expect(cleanOpener(null)).toBeUndefined();
    expect(cleanOpener("dusk")).toBeUndefined();
  });

  it("an unsafe opener never costs the script", () => {
    const out = normalizeScriptJson({ voice: "Sarah", openerPrompt: "A poster with our prices, warm light everywhere" }) as {
      openerPrompt?: string;
      voice?: string;
    };
    expect(out.openerPrompt).toBeUndefined();
    expect(out.voice).toBe("Sarah");
  });
});

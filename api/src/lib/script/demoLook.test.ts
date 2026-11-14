import { describe, expect, it } from "vitest";
import { adScriptSchema, defaultVoiceFor, normalizeScriptJson } from "./schema.js";

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

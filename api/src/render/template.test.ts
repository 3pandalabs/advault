import { describe, expect, it } from "vitest";
import { brandColorFor, displayDomain, timeCaptions } from "./template.js";
import { normalizeScriptJson } from "../lib/script/schema.js";
import { stripAudioTags } from "../lib/ai/voice/index.js";

describe("template ad helpers", () => {
  it("spreads captions over the voiceover by word count", () => {
    const cues = timeCaptions(["Bella Hair Studio", "Ten dollars off", "Book today"], 8.2);
    expect(cues[0].from).toBe(0.1);
    expect(cues.at(-1)!.to).toBeCloseTo(8.1, 1);
    // 3 words, 3 words, 2 words
    expect(cues[0].to - cues[0].from).toBeCloseTo(cues[1].to - cues[1].from, 1);
    expect(cues[2].to - cues[2].from).toBeLessThan(cues[0].to - cues[0].from);
  });

  it("picks a palette by category, stably for unknown ones", () => {
    expect(brandColorFor("Hair Salon")).toBe("#8c1f5b");
    expect(brandColorFor("Pet grooming")).toBe(brandColorFor("pet grooming"));
  });

  it("shows a bare domain", () => {
    expect(displayDomain("https://www.bellahair.com/book?x=1")).toBe("bellahair.com");
    expect(displayDomain("not a url")).toBe("");
  });

  it("strips ElevenLabs audio tags for edge-tts", () => {
    expect(stripAudioTags("[warmly] Bella Hair Studio! [cheerfully] Book today.")).toBe("Bella Hair Studio! Book today.");
  });

  it("fits the sticker to the template instead of dropping the script", () => {
    const out = normalizeScriptJson({
      hook: "x",
      sticker: { badge: "$10 off", headline: "your very first haircut at our studio", tagline: "this month only", benefits: ["a", "b", "c"] },
    }) as { sticker: { badge: string; headline: string; benefits: string[] } };
    expect(out.sticker.badge).toBe("$10 OFF");
    expect(out.sticker.headline.length).toBeLessThanOrEqual(24);
    expect(out.sticker.benefits).toEqual(["a", "b"]);
    expect((normalizeScriptJson({ sticker: { badge: "", headline: "x", tagline: "y" } }) as { sticker?: unknown }).sticker).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import { FAL_MOTION_PROMPT, FAL_MOTION_STYLE, falMotionPrompt } from "./index.js";

describe("falMotionPrompt", () => {
  it("swaps the old gentle push-in ending for a visible camera move", () => {
    const out = falMotionPrompt("Clouds drift across the skyline, slow gentle push-in.");
    expect(out).not.toMatch(/gentle push-in/i);
    expect(out.startsWith("Clouds drift across the skyline, smooth dolly-in with real parallax.")).toBe(true);
    expect(out.endsWith(FAL_MOTION_STYLE)).toBe(true);
  });

  it("keeps a new-style line as written", () => {
    const line = "The stylist keeps cutting hair, slow orbit around the chair.";
    expect(falMotionPrompt(line)).toBe(line + FAL_MOTION_STYLE);
  });

  it("falls back to the generic prompt", () => {
    expect(falMotionPrompt()).toBe(FAL_MOTION_PROMPT);
    expect(FAL_MOTION_PROMPT).not.toMatch(/gentle|softly|small/i);
  });
});

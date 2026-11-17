import { describe, expect, it } from "vitest";
import { isReformatCopy, otherAspect } from "./reformatPolicy.js";
import { blurPadFilter, frameSize } from "../../render/reformat.js";

describe("other format", () => {
  it("swaps the two shapes and nothing else", () => {
    expect(otherAspect("16:9")).toBe("9:16");
    expect(otherAspect("9:16")).toBe("16:9");
    expect(otherAspect("1:1")).toBeNull();
  });
  it("recognises a copy by its render info", () => {
    expect(isReformatCopy({ engine: "reformat", from: "x" })).toBe(true);
    expect(isReformatCopy({ engine: "template" })).toBe(false);
    expect(isReformatCopy(null)).toBe(false);
  });
  it("frames each shape at 1080p", () => {
    expect(frameSize("16:9")).toEqual({ w: 1920, h: 1080 });
    expect(frameSize("9:16")).toEqual({ w: 1080, h: 1920 });
  });
  it("builds a blurred backdrop with the original on top", () => {
    const f = blurPadFilter(1920, 1080);
    expect(f).toContain("force_original_aspect_ratio=increase,crop=1920:1080,boxblur");
    expect(f).toContain("force_original_aspect_ratio=decrease[fg]");
    expect(f).toContain("overlay=(W-w)/2:(H-h)/2");
  });
});

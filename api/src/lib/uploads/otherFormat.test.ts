import { describe, expect, it } from "vitest";
import { isReformatCopy, needsReformatCopy, otherAspect, shapeUploadPlan } from "./reformatPolicy.js";
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

describe("both shapes: upload rules", () => {
  const own = (aspectRatio: string, extra: Record<string, unknown> = {}) => ({ id: `own-${aspectRatio}`, aspectRatio, renderStatus: "ready", renderInfo: null, ...extra });
  const copy = (aspectRatio: string, extra: Record<string, unknown> = {}) => ({ id: `copy-${aspectRatio}`, aspectRatio, renderStatus: "queued", renderInfo: { engine: "reformat", from: "x" }, ...extra });

  it("allows the other shape, refuses the same shape", () => {
    expect(shapeUploadPlan([own("9:16")], "16:9")).toEqual({ ok: true, replaceCopyIds: [] });
    expect(shapeUploadPlan([own("9:16")], "9:16")).toEqual({ ok: false, error: "already_uploaded" });
    expect(shapeUploadPlan([own("9:16", { renderInfo: null })], "9:16")).toEqual({ ok: false, error: "already_uploaded" });
  });
  it("replaces AdVault's copy in that shape, whatever its render state", () => {
    for (const renderStatus of ["queued", "rendering", "ready", "failed"]) {
      expect(shapeUploadPlan([own("9:16"), copy("16:9", { renderStatus })], "16:9")).toEqual({ ok: true, replaceCopyIds: ["copy-16:9"] });
    }
  });
  it("never replaces a copy that is in a Google ad or uploading to YouTube", () => {
    expect(shapeUploadPlan([copy("16:9", { googleAdResourceName: "ads/1" })], "16:9")).toEqual({ ok: false, error: "creative_is_live" });
    expect(shapeUploadPlan([copy("16:9", { youtubeUploadStatus: "uploading" })], "16:9")).toEqual({ ok: false, error: "upload_in_progress" });
  });
  it("makes a copy only when the owner has not uploaded that shape", () => {
    expect(needsReformatCopy([])).toBe(true);
    expect(needsReformatCopy([own("16:9")])).toBe(false);
    expect(needsReformatCopy([own("16:9", { reviewStatus: "rejected" })])).toBe(false);
    expect(needsReformatCopy([copy("16:9")])).toBe(false);
    expect(needsReformatCopy([copy("16:9", { renderStatus: "failed" })])).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { checkUploadedVideo } from "./policy.js";

describe("checkUploadedVideo", () => {
  it("accepts vertical and wide HD videos and reports the aspect", () => {
    expect(checkUploadedVideo({ width: 1080, height: 1920, durationSeconds: 32 })).toEqual({ ok: true, aspectRatio: "9:16" });
    expect(checkUploadedVideo({ width: 1920, height: 1080, durationSeconds: 15 })).toEqual({ ok: true, aspectRatio: "16:9" });
    expect(checkUploadedVideo({ width: 1080, height: 1916, durationSeconds: 20 })).toEqual({ ok: true, aspectRatio: "9:16" });
  });

  it("refuses other shapes, tiny videos and bad lengths", () => {
    expect(checkUploadedVideo({ width: 1080, height: 1350, durationSeconds: 20 })).toEqual({ ok: false, error: "unsupported_aspect_ratio" });
    expect(checkUploadedVideo({ width: 360, height: 640, durationSeconds: 20 })).toEqual({ ok: false, error: "too_small" });
    expect(checkUploadedVideo({ width: 1080, height: 1920, durationSeconds: 3 })).toEqual({ ok: false, error: "too_short" });
    expect(checkUploadedVideo({ width: 1080, height: 1920, durationSeconds: 600 })).toEqual({ ok: false, error: "too_long" });
  });
});

import { describe, expect, it } from "vitest";
import { ADMIN_UPLOAD_LIMITS, CUSTOMER_UPLOAD_LIMITS, checkUploadedVideo, uploadLimitsFor } from "./policy.js";

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

describe("customer upload limits", () => {
  const limits = uploadLimitsFor("user");

  it("allows 6 to 60 seconds", () => {
    expect(checkUploadedVideo({ width: 1080, height: 1920, durationSeconds: 6 }, limits).ok).toBe(true);
    expect(checkUploadedVideo({ width: 1080, height: 1920, durationSeconds: 60 }, limits).ok).toBe(true);
    expect(checkUploadedVideo({ width: 1080, height: 1920, durationSeconds: 5.5 }, limits)).toEqual({ ok: false, error: "too_short" });
    expect(checkUploadedVideo({ width: 1920, height: 1080, durationSeconds: 61 }, limits)).toEqual({ ok: false, error: "too_long" });
  });

  it("keeps the wider window for admins", () => {
    expect(uploadLimitsFor("admin")).toEqual(ADMIN_UPLOAD_LIMITS);
    expect(uploadLimitsFor(undefined)).toEqual(CUSTOMER_UPLOAD_LIMITS);
    expect(checkUploadedVideo({ width: 1920, height: 1080, durationSeconds: 120 }, uploadLimitsFor("admin")).ok).toBe(true);
  });
});

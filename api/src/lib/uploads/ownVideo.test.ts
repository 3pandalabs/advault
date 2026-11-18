import { describe, expect, it } from "vitest";
import { initialReviewStatus, ownVideoAllowed } from "./review.js";

describe("own video upload gate (paused for customers at launch)", () => {
  const off = { OWN_VIDEO_UPLOADS: undefined };

  it("admins and internal accounts may upload; a plain customer may not", () => {
    expect(ownVideoAllowed("admin", false, off)).toBe(true);
    expect(ownVideoAllowed("advertiser", true, off)).toBe(true);
    expect(ownVideoAllowed("advertiser", false, off)).toBe(false);
    expect(ownVideoAllowed(undefined, false, off)).toBe(false);
  });

  it("an internal account's upload still waits for admin review", () => {
    expect(initialReviewStatus("advertiser")).toBe("pending_review");
  });

  it("OWN_VIDEO_UPLOADS=on opens it to everyone", () => {
    expect(ownVideoAllowed("advertiser", false, { OWN_VIDEO_UPLOADS: "on" })).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import {
  REJECT_REASON_MAX,
  initialReviewStatus,
  launchReviewGate,
  mayPublishToYoutube,
  reviewTransition,
} from "./review.js";

describe("initialReviewStatus", () => {
  it("queues customer uploads and approves an admin's own", () => {
    expect(initialReviewStatus("user")).toBe("pending_review");
    expect(initialReviewStatus(undefined)).toBe("pending_review");
    expect(initialReviewStatus("admin")).toBe("approved");
  });
});

describe("reviewTransition", () => {
  it("approves or rejects a pending video", () => {
    expect(reviewTransition("pending_review", { decision: "approve" })).toEqual({ ok: true, next: "approved", reason: null });
    expect(reviewTransition("pending_review", { decision: "reject", reason: "  Copyrighted song  " })).toEqual({
      ok: true,
      next: "rejected",
      reason: "Copyrighted song",
    });
  });

  it("requires a reason to reject, and caps it", () => {
    expect(reviewTransition("pending_review", { decision: "reject", reason: "   " })).toEqual({ ok: false, error: "reason_required" });
    const long = reviewTransition("pending_review", { decision: "reject", reason: "x".repeat(900) });
    expect(long.ok && long.reason?.length).toBe(REJECT_REASON_MAX);
  });

  it("treats a decision as final and generated videos as unreviewable", () => {
    expect(reviewTransition("approved", { decision: "reject", reason: "changed my mind" })).toEqual({ ok: false, error: "already_reviewed" });
    expect(reviewTransition("rejected", { decision: "approve" })).toEqual({ ok: false, error: "already_reviewed" });
    expect(reviewTransition(null, { decision: "approve" })).toEqual({ ok: false, error: "not_reviewable" });
  });
});

describe("mayPublishToYoutube", () => {
  it("lets generated and approved videos through only", () => {
    expect(mayPublishToYoutube(null)).toBe(true);
    expect(mayPublishToYoutube("approved")).toBe(true);
    expect(mayPublishToYoutube("pending_review")).toBe(false);
    expect(mayPublishToYoutube("rejected")).toBe(false);
  });
});

describe("launchReviewGate", () => {
  it("leaves AdVault-generated campaigns untouched", () => {
    expect(launchReviewGate([{ id: "a", reviewStatus: null }, { id: "b", reviewStatus: null }])).toEqual({
      ok: true,
      eligibleIds: ["a", "b"],
    });
  });

  it("allows approved uploads", () => {
    expect(launchReviewGate([{ id: "u", reviewStatus: "approved" }])).toEqual({ ok: true, eligibleIds: ["u"] });
  });

  it("blocks while any upload is pending, even next to a generated video", () => {
    expect(launchReviewGate([{ id: "u", reviewStatus: "pending_review" }])).toEqual({ ok: false, error: "video_pending_review" });
    expect(
      launchReviewGate([
        { id: "g", reviewStatus: null },
        { id: "u", reviewStatus: "pending_review" },
      ]),
    ).toEqual({ ok: false, error: "video_pending_review" });
  });

  it("drops rejected uploads, and refuses when nothing else is left", () => {
    expect(launchReviewGate([{ id: "u", reviewStatus: "rejected" }])).toEqual({ ok: false, error: "video_rejected" });
    expect(
      launchReviewGate([
        { id: "g", reviewStatus: null },
        { id: "u", reviewStatus: "rejected" },
      ]),
    ).toEqual({ ok: true, eligibleIds: ["g"] });
  });

  it("returns an empty list for no candidates (launch answers no_ready_creatives)", () => {
    expect(launchReviewGate([])).toEqual({ ok: true, eligibleIds: [] });
  });
});

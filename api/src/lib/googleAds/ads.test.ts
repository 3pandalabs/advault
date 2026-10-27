import { describe, expect, it } from "vitest";
import { videoAdFormatFor } from "./ads.js";

// The ad group's `type` is IMMUTABLE at Google: get it wrong and the only fix
// is deleting the ad group and recreating it, which on a live campaign means a
// gap in delivery. Google also enforces the length limits per format and
// rejects the mutate rather than truncating, so every boundary below is a
// launch that either works or 400s.
describe("videoAdFormatFor", () => {
  it("uses a bumper at the 6-second limit and below", () => {
    for (const seconds of [1, 5, 6]) {
      expect(videoAdFormatFor(seconds)).toEqual({
        format: "bumper",
        adGroupType: "VIDEO_BUMPER",
      });
    }
  });

  it("moves to non-skippable the moment it passes 6 seconds", () => {
    expect(videoAdFormatFor(6.5)).toEqual({
      format: "nonSkippable",
      adGroupType: "VIDEO_NON_SKIPPABLE_IN_STREAM",
    });
    expect(videoAdFormatFor(7)).toEqual({
      format: "nonSkippable",
      adGroupType: "VIDEO_NON_SKIPPABLE_IN_STREAM",
    });
  });

  // The default pipeline renders ~13.5s. This is the case that actually runs in
  // production, so it is asserted explicitly rather than left to a range.
  it("puts the default ~13.5s render on non-skippable in-stream", () => {
    expect(videoAdFormatFor(13.5).adGroupType).toBe("VIDEO_NON_SKIPPABLE_IN_STREAM");
  });

  it("treats 15 seconds as the last non-skippable length", () => {
    expect(videoAdFormatFor(15).adGroupType).toBe("VIDEO_NON_SKIPPABLE_IN_STREAM");
    expect(videoAdFormatFor(15.1).adGroupType).toBe("VIDEO_TRUE_VIEW_IN_STREAM");
  });

  // 20s is allowed for non-skippable in some markets, but the API does not say
  // which, so anything over 15 takes the skippable format that has no limit.
  // Being conservative costs a format; being wrong costs the launch.
  it("falls back to skippable in-stream for anything longer", () => {
    for (const seconds of [16, 20, 30, 120]) {
      expect(videoAdFormatFor(seconds)).toEqual({
        format: "inStream",
        adGroupType: "VIDEO_TRUE_VIEW_IN_STREAM",
      });
    }
  });

  // durationSeconds is nullable on creatives, and the launch route defaults it
  // to 15. A zero or negative duration should never reach here, but if it does,
  // a bumper is the only format it could legally be.
  it("does not produce a non-bumper format for a zero duration", () => {
    expect(videoAdFormatFor(0).adGroupType).toBe("VIDEO_BUMPER");
  });
});

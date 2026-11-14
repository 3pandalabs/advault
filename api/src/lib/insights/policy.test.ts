import { describe, expect, it } from "vitest";
import { segmentOf, type CustomerFacts } from "./policy.js";

const now = new Date("2026-11-14T12:00:00Z");
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);
const blank: CustomerFacts = {
  createdAt: daysAgo(100),
  photos: 0,
  campaigns: 0,
  adsMade: 0,
  paidAds: 0,
  launched: 0,
  liveNow: 0,
  activeMonths90d: 0,
  lastActivityAt: null,
};

describe("segmentOf", () => {
  it("regular beats live", () => {
    expect(segmentOf({ ...blank, activeMonths90d: 2, liveNow: 1, launched: 1 }, now)).toBe("regular");
  });
  it("live", () => expect(segmentOf({ ...blank, liveNow: 1, launched: 1 }, now)).toBe("live"));
  it("paused vs lapsed by last activity", () => {
    expect(segmentOf({ ...blank, launched: 1, lastActivityAt: daysAgo(10) }, now)).toBe("paused");
    expect(segmentOf({ ...blank, launched: 1, lastActivityAt: daysAgo(90) }, now)).toBe("lapsed");
  });
  it("trying: an ad but no launch", () => {
    expect(segmentOf({ ...blank, adsMade: 2 }, now)).toBe("trying");
    expect(segmentOf({ ...blank, paidAds: 1 }, now)).toBe("trying");
  });
  it("new, stalled, never started", () => {
    expect(segmentOf({ ...blank, createdAt: daysAgo(5), photos: 3 }, now)).toBe("new");
    expect(segmentOf({ ...blank, photos: 3 }, now)).toBe("stalled");
    expect(segmentOf(blank, now)).toBe("never_started");
  });
});

import { describe, expect, it } from "vitest";
import { sitePlanCoverUntil } from "./policy.js";

const now = new Date("2026-11-19T12:00:00Z");
const end = new Date("2026-12-19T12:00:00Z");

describe("website included while the plan runs", () => {
  it("covers to the end of a live plan's paid period", () => {
    expect(sitePlanCoverUntil({ status: "active", currentPeriodEnd: end }, now)).toEqual(end);
    expect(sitePlanCoverUntil({ status: "past_due", currentPeriodEnd: end }, now)).toEqual(end);
  });

  it("covers nothing without a live, unexpired plan", () => {
    expect(sitePlanCoverUntil(null, now)).toBeNull();
    expect(sitePlanCoverUntil({ status: "pending", currentPeriodEnd: end }, now)).toBeNull();
    expect(sitePlanCoverUntil({ status: "canceled", currentPeriodEnd: end }, now)).toBeNull();
    expect(sitePlanCoverUntil({ status: "active", currentPeriodEnd: new Date("2026-11-01T00:00:00Z") }, now)).toBeNull();
    expect(sitePlanCoverUntil({ status: "active", currentPeriodEnd: null }, now)).toBeNull();
  });
});

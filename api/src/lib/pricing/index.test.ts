import { describe, expect, it } from "vitest";
import { buysMedia, hasMonthlyOffers, planByKey, PLANS, PRODUCT_LINES } from "./index.js";

describe("plans", () => {
  it("every plan's line is a known product line", () => {
    for (const p of Object.values(PLANS)) expect(PRODUCT_LINES).toContain(p.line);
  });

  it("Keep it running is $19/month, US only, from $1/day", () => {
    const p = planByKey("us-evergreen")!;
    expect(p.line).toBe("evergreen");
    expect(p.currency).toBe("USD");
    expect(p.monthlyFeeMinor).toBe(1_900);
    expect(p.minDailyBudgetMinor).toBe(100);
    expect(planByKey("in-evergreen")).toBeNull();
  });

  it("keeps evergreen out of the monthly offer loop but buying media", () => {
    expect(hasMonthlyOffers("evergreen")).toBe(false);
    expect(hasMonthlyOffers("offer")).toBe(true);
    expect(hasMonthlyOffers("managed")).toBe(true);
    expect(buysMedia("evergreen")).toBe(true);
    expect(buysMedia("offer")).toBe(false);
  });
});

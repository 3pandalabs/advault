import { describe, expect, it } from "vitest";
import { addOnFor, addOnPriceMinor, maybeAddOnFor, freeFirstAd, freeFirstAdPlacesLeft, buysMedia, hasMonthlyOffers, planByKey, PLANS, PRODUCT_LINES, adSpendTotalMinor, runEndDate } from "./index.js";

describe("run length", () => {
  it("totals: 1 week = daily x 7, 2 weeks = x 14, always on = about a month (x 30.4)", () => {
    expect(adSpendTotalMinor(500, 7)).toBe(3_500);
    expect(adSpendTotalMinor(500, 14)).toBe(7_000);
    expect(adSpendTotalMinor(500, null)).toBe(15_200);
    expect(adSpendTotalMinor(1_234, null)).toBe(37_514); // rounded to the cent
  });

  it("Keep it running suggests one week at the $5 floor ($35)", () => {
    const p = planByKey("us-evergreen")!;
    expect(p.suggestedAdBudgetMinor).toBe(adSpendTotalMinor(p.minDailyBudgetMinor, 7));
  });

  it("end date = start + days - 1, across month/year ends; null for always on", () => {
    expect(runEndDate("2026-11-18", 7)).toBe("2026-11-24");
    expect(runEndDate("2026-11-18", 14)).toBe("2026-12-01");
    expect(runEndDate("2026-12-28", 7)).toBe("2027-01-03");
    expect(runEndDate("2026-11-18", null)).toBeNull();
    expect(() => runEndDate("nope", 7)).toThrow();
  });
});

describe("plans", () => {
  it("every plan's line is a known product line", () => {
    for (const p of Object.values(PLANS)) expect(PRODUCT_LINES).toContain(p.line);
  });

  it("Keep it running is $20/month for new plans, US only, from $5/day", () => {
    const p = planByKey("us-evergreen")!;
    expect(p.line).toBe("evergreen");
    expect(p.currency).toBe("USD");
    expect(p.monthlyFeeMinor).toBe(2_000);
    expect(p.minDailyBudgetMinor).toBe(500);
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

describe("new ad", () => {
  it("costs $10 for the first ad and every one after", () => {
    const a = addOnFor("USD", "new_ad");

    expect(a.key).toBe("us-new_ad");
    expect(addOnPriceMinor(a, { priorPaidCount: 0 })).toBe(1_000);
    expect(addOnPriceMinor(a, { priorPaidCount: 5 })).toBe(1_000);
  });
});

describe("free first ad launch offer", () => {
  // Dropped 2026-11-13 (FREE_FIRST_AD_LIMIT = 0): every ad is paid.
  it("gives no free ads", () => {
    expect(freeFirstAd({ priorAdsClaimed: 0, freeAdsClaimedByAnyone: 0 })).toBe(false);
    expect(freeFirstAdPlacesLeft(0)).toBe(0);
  });
});

describe("cinematic pricing (2026-11-14)", () => {
  it("is $29 the first time and $39 after", () => {
    const a = addOnFor("USD", "cinematic");
    expect(addOnPriceMinor(a, { priorPaidCount: 0 })).toBe(2_900);
    expect(addOnPriceMinor(a, { priorPaidCount: 1 })).toBe(3_900);
  });

  it("sells three for $99 in the US only", () => {
    const pack = maybeAddOnFor("USD", "cinematic_pack");
    expect(pack?.credits).toBe(3);
    expect(addOnPriceMinor(pack!, { priorPaidCount: 0 })).toBe(9_900);
    expect(addOnPriceMinor(pack!, { priorPaidCount: 5 })).toBe(9_900);
    expect(maybeAddOnFor("INR", "cinematic_pack")).toBeNull();
  });
});

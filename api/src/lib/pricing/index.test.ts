import { describe, expect, it } from "vitest";
import { addOnFor, addOnPriceMinor, maybeAddOnFor, freeFirstAd, freeFirstAdPlacesLeft, buysMedia, hasMonthlyOffers, planByKey, PLANS, PRODUCT_LINES } from "./index.js";

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

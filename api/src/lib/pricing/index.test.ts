import { describe, expect, it } from "vitest";
import { addOnFor, addOnPriceMinor, freeFirstAd, freeFirstAdPlacesLeft, buysMedia, hasMonthlyOffers, planByKey, PLANS, PRODUCT_LINES } from "./index.js";

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
  it("is the first ad only, for the first 30 customers", () => {
    expect(freeFirstAd({ priorAdsClaimed: 0, freeAdsClaimedByAnyone: 0 })).toBe(true);
    expect(freeFirstAd({ priorAdsClaimed: 0, freeAdsClaimedByAnyone: 29 })).toBe(true);
    expect(freeFirstAd({ priorAdsClaimed: 0, freeAdsClaimedByAnyone: 30 })).toBe(false);
    expect(freeFirstAd({ priorAdsClaimed: 1, freeAdsClaimedByAnyone: 0 })).toBe(false);
  });

  it("counts places left without going negative", () => {
    expect(freeFirstAdPlacesLeft(0)).toBe(30);
    expect(freeFirstAdPlacesLeft(31)).toBe(0);
  });
});

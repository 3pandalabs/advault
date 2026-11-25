// Badges, the plan offer builder and claim checks (lib/categories).
import { describe, expect, it } from "vitest";
import { BADGES, BADGES_BY_CATEGORY, MAX_BADGES, badgeChips, badgeOptions, badgeViolation } from "./badges.js";
import { claimBlock, claimFlags } from "./claims.js";
import { CATEGORY_KEYS } from "./key.js";
import { PLAN_OFFER_CATEGORIES, PLAN_SERVICE, planOfferProblem, planOfferText } from "./planOffer.js";

describe("badges", () => {
  it("every category's options exist and chips fit the end card", () => {
    for (const k of CATEGORY_KEYS) for (const id of BADGES_BY_CATEGORY[k]) expect(BADGES[id], `${k}:${id}`).toBeDefined();
    for (const b of Object.values(BADGES)) expect(b.chip.length).toBeLessThanOrEqual(24);
  });

  it("offers the spec's credentials where they belong", () => {
    expect(badgeOptions("auto")).toContain("ase_certified");
    expect(badgeOptions("landscaping")).toContain("pesticide_license");
    expect(badgeOptions("dentistry")).toEqual(["insurance_accepted", "financing"]);
    expect(badgeOptions("plumbing")).toContain("emergency_24_7");
    expect(badgeOptions("restaurant")).toEqual([]);
    expect(badgeOptions(null)).toEqual(["licensed_insured", "upfront_pricing", "financing"]);
  });

  it("an empty selection always saves", () => {
    expect(badgeViolation("plumbing", { ids: [] }, false)).toBeNull();
  });

  it("needs the attestation, a valid license number, allowed ids, at most four", () => {
    expect(badgeViolation("plumbing", { ids: ["licensed_insured"] }, false)).toBe("badge_attestation_required");
    expect(badgeViolation("plumbing", { ids: ["licensed_insured"] }, true)).toBeNull();
    expect(badgeViolation("dentistry", { ids: ["licensed_insured"] }, true)).toBe("badge_not_for_category");
    expect(badgeViolation("plumbing", { ids: ["license_number"] }, true)).toBe("badge_license_number_required");
    expect(badgeViolation("plumbing", { ids: ["license_number"], licenseNumber: "<script>" }, true)).toBe("badge_license_number_invalid");
    expect(badgeViolation("plumbing", { ids: ["license_number"], licenseNumber: "PL-12345" }, true)).toBeNull();
    expect(badgeViolation("plumbing", { ids: ["financing", "financing"] }, true)).toBe("badge_duplicate");
    const five = badgeOptions("plumbing").slice(0, MAX_BADGES + 1).filter((id) => id !== "license_number");
    expect(badgeViolation("plumbing", { ids: [...five, "license_number"], licenseNumber: "1" }, true)).toBe("badge_too_many");
  });

  it("chips in the order picked, the license number filled in", () => {
    expect(badgeChips({ ids: ["license_number", "licensed_insured"], licenseNumber: " PL-12345 " })).toEqual([
      "LIC #PL-12345",
      "Licensed & insured",
    ]);
    expect(badgeChips({ ids: ["license_number"] })).toEqual([]);
    expect(badgeChips(null)).toEqual([]);
  });
});

describe("plan offer builder", () => {
  it("is offered for landscaping, cleaning and HVAC, each with a default service", () => {
    expect(PLAN_OFFER_CATEGORIES).toEqual(["landscaping", "cleaning", "hvac", "carWash"]);
    for (const k of PLAN_OFFER_CATEGORIES) expect(PLAN_SERVICE[k]).toBeTruthy();
  });

  it("writes the offer text per visit, month or season", () => {
    expect(planOfferText({ service: "Weekly mowing", cadence: "visit", price: 35, currencyCode: "USD" })).toBe(
      "Weekly mowing from $35 a visit.",
    );
    expect(
      planOfferText({ service: "Home cleaning.", cadence: "month", price: 199.5, currencyCode: "USD", firstVisit: { kind: "percent", value: 50 } }),
    ).toBe("Home cleaning from $199.50 a month. First visit 50% off.");
    expect(
      planOfferText({ service: "AC and furnace plan", cadence: "season", price: 1500, currencyCode: "INR", firstVisit: { kind: "amount", value: 500 } }),
    ).toBe("AC and furnace plan from ₹1,500 a season. ₹500 off your first visit.");
    expect(planOfferText({ service: "Mowing", cadence: "visit", price: 40, currencyCode: "USD", firstVisit: { kind: "free" } })).toBe(
      "Mowing from $40 a visit. First visit free.",
    );
  });

  it("refuses a missing service, a bad price or a deal bigger than the price", () => {
    expect(planOfferProblem({ service: " ", cadence: "visit", price: 35, currencyCode: "USD" })).toBe("plan_service_required");
    expect(planOfferProblem({ service: "x", cadence: "visit", price: 0, currencyCode: "USD" })).toBe("plan_price_invalid");
    expect(planOfferProblem({ service: "x", cadence: "visit", price: 35, currencyCode: "USD", firstVisit: { kind: "amount", value: 35 } })).toBe(
      "plan_deal_invalid",
    );
    expect(planOfferProblem({ service: "x", cadence: "visit", price: 35, currencyCode: "USD", firstVisit: { kind: "percent", value: 0 } })).toBe(
      "plan_deal_invalid",
    );
    expect(planOfferText({ service: "", cadence: "visit", price: 35, currencyCode: "USD" })).toBeNull();
  });

  it("never mentions a daily budget", () => {
    expect(planOfferText({ service: "Mowing", cadence: "month", price: 120, currencyCode: "USD" })).not.toMatch(/day/i);
  });
});

describe("claim checks", () => {
  const ids = (k: Parameters<typeof claimFlags>[0], t: string) => claimFlags(k, t).map((f) => f.id);

  it("dentistry: painless, best dentist, guarantees", () => {
    expect(ids("dentistry", "Painless cleanings by the best dentist in town. Results guaranteed.")).toEqual(
      expect.arrayContaining(["health_painless", "health_best", "health_guarantee"]),
    );
    expect(ids("dentistry", "Gentle cleanings, evening appointments.")).toEqual([]);
  });

  it("lawn chemicals: 100% pet-safe, guaranteed green", () => {
    expect(ids("landscaping", "Fertilizer that is 100% pet-safe.")).toContain("lawn_safe");
    expect(ids("landscaping", "Non-toxic weed control")).toContain("lawn_safe");
    expect(ids("landscaping", "Guaranteed green by June")).toContain("lawn_guaranteed_green");
    expect(ids("landscaping", "Weekly mowing from $35.")).toEqual([]);
  });

  it("financing: 0% without terms warns, with terms it doesn't", () => {
    expect(ids("hvac", "New AC with 0% financing!")).toContain("financing_terms");
    expect(ids("hvac", "0% financing for 12 months with approved credit, see terms.")).not.toContain("financing_terms");
    expect(ids("hvac", "Financing available.")).not.toContain("financing_terms");
  });

  it("real estate: exclusion is blocked, preferences warn", () => {
    expect(claimBlock("realEstate", "Quiet condo, adults only.")?.id).toBe("housing_exclusion");
    expect(claimBlock("realEstate", "No kids, no pets.")?.id).toBe("housing_exclusion");
    expect(claimBlock("realEstate", "Perfect for families, safe neighborhood.")).toBeNull();
    expect(ids("realEstate", "Perfect for families, safe neighborhood.")).toEqual(["housing_preference"]);
    expect(claimBlock("realEstate", "3 bed, 2 bath, new roof, walk to Maple Park.")).toBeNull();
  });

  it("blocks only in real estate; other categories only ever warn", () => {
    expect(claimBlock("cleaning", "Adults only cleaning crew. The best in town, guaranteed!")).toBeNull();
    expect(claimFlags("cleaning", "The best in town, guaranteed!").every((f) => f.level === "warn")).toBe(true);
  });

  it("superlatives warn everywhere, typed-in categories included", () => {
    expect(ids(null, "#1 bakery in Edison")).toContain("superlative");
    expect(ids(null, "Fresh bread daily")).toEqual([]);
  });

  it("each flag carries the matched words and a reason; blocks first", () => {
    const f = claimFlags("realEstate", "Perfect for families. Adults only.");
    expect(f[0]).toMatchObject({ level: "block", phrase: "Adults only" });
    expect(f.every((x) => x.reason.length > 20)).toBe(true);
    expect(claimFlags("hvac", "")).toEqual([]);
  });
});

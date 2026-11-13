import { describe, expect, it } from "vitest";
import {
  activeFilterCount,
  audienceFiltersSchema,
  isHousingCategory,
  normalizeAudienceFilters,
  targetAddressSchema,
  targetingViolations,
  type AudienceFilters,
  type TargetingInput,
} from "./policy.js";
import { ageSegments, audienceDimensions, languageConstants } from "./google.js";

const address = { street: "12 Elm St", city: "Austin", state: "TX", postalCode: "78701" };

const housing = (over: Partial<TargetingInput> = {}): TargetingInput => ({
  businessCategory: "Real estate",
  targetZipCodes: [],
  targetAddress: address,
  audienceFilters: null,
  ...over,
});

describe("audienceFiltersSchema", () => {
  it("accepts every documented bucket", () => {
    const r = audienceFiltersSchema.safeParse({
      ages: ["18-24", "65+", "unknown"],
      genders: ["female"],
      parentalStatuses: ["not_parent"],
      incomes: ["top_10", "lower_50"],
      languages: ["en", "es"],
    });
    expect(r.success).toBe(true);
  });

  it("rejects unknown values, duplicates and unknown keys", () => {
    expect(audienceFiltersSchema.safeParse({ ages: ["13-17"] }).success).toBe(false);
    expect(audienceFiltersSchema.safeParse({ genders: ["male", "male"] }).success).toBe(false);
    expect(audienceFiltersSchema.safeParse({ languages: ["klingon"] }).success).toBe(false);
    // A typo'd key must not become a silently ignored filter.
    expect(audienceFiltersSchema.safeParse({ gender: ["male"] }).success).toBe(false);
  });

  it("accepts an empty object (everyone)", () => {
    expect(audienceFiltersSchema.safeParse({}).success).toBe(true);
  });
});

describe("normalizeAudienceFilters", () => {
  it("is null for nothing, empty lists, or a dimension with every option ticked", () => {
    expect(normalizeAudienceFilters(null)).toBeNull();
    expect(normalizeAudienceFilters({ ages: [], languages: [] })).toBeNull();
    expect(normalizeAudienceFilters({ genders: ["unknown", "female", "male"] })).toBeNull();
    expect(activeFilterCount({ genders: ["male", "female", "unknown"] })).toBe(0);
  });

  it("keeps a partial selection, in Google's bucket order", () => {
    expect(normalizeAudienceFilters({ ages: ["65+", "18-24"], genders: ["male", "female"] })).toEqual({
      ages: ["18-24", "65+"],
      genders: ["male", "female"],
    });
    expect(activeFilterCount({ ages: ["25-34"], languages: ["es"] })).toBe(2);
  });
});

describe("housing (US real estate) policy", () => {
  it("recognises real-estate categories, including free text", () => {
    for (const c of ["Real estate", "real-estate agent", "Realtor", "Apartments for rent", "Mortgage broker"]) {
      expect(isHousingCategory(c)).toBe(true);
    }
    for (const c of ["Plumbing", "Dentistry", "Restaurant", "Cleaning services", ""]) {
      expect(isHousingCategory(c)).toBe(false);
    }
  });

  it("allows a radius around the listing with no filters", () => {
    expect(targetingViolations(housing())).toEqual([]);
  });

  it.each<[string, AudienceFilters]>([
    ["ages", { ages: ["25-34"] }],
    ["genders", { genders: ["female"] }],
    ["parentalStatuses", { parentalStatuses: ["parent"] }],
  ])("rejects %s targeting", (_k, filters) => {
    expect(targetingViolations(housing({ audienceFilters: filters }))).toContain(
      "housing_demographics_not_allowed",
    );
  });

  // Google's FAQ lists household income as NOT restricted for housing, and
  // language was never restricted.
  it("allows household income and language", () => {
    expect(
      targetingViolations(housing({ audienceFilters: { incomes: ["top_10"], languages: ["es"] } })),
    ).toEqual([]);
  });

  it("rejects ZIP targeting and requires the listing address", () => {
    expect(targetingViolations(housing({ targetZipCodes: ["78701"] }))).toContain(
      "housing_zip_targeting_not_allowed",
    );
    expect(targetingViolations(housing({ targetAddress: null }))).toContain("listing_address_required");
  });

  it("does not count an all-ticked dimension as a demographic filter", () => {
    expect(
      targetingViolations(housing({ audienceFilters: { genders: ["male", "female", "unknown"] } })),
    ).toEqual([]);
  });

  it("leaves non-housing campaigns free to use demographics, but needs ZIPs", () => {
    const plumber = {
      businessCategory: "Plumbing",
      targetZipCodes: ["94110"],
      targetAddress: null,
      audienceFilters: { ages: ["35-44"], genders: ["male"] },
    } as TargetingInput;
    expect(targetingViolations(plumber)).toEqual([]);
    expect(targetingViolations({ ...plumber, targetZipCodes: [] })).toEqual(["zip_codes_required"]);
  });

  it("validates the listing address", () => {
    expect(targetAddressSchema.safeParse(address).success).toBe(true);
    expect(targetAddressSchema.safeParse({ ...address, state: "Texas" }).success).toBe(false);
    expect(targetAddressSchema.safeParse({ ...address, postalCode: "560001" }).success).toBe(false);
  });
});

describe("Google Ads audience mapping", () => {
  it("merges adjacent age buckets into contiguous AgeSegments", () => {
    expect(ageSegments(["25-34", "35-44", "65+"])).toEqual([
      { minAge: 25, maxAge: 44 },
      { minAge: 65 },
    ]);
    expect(ageSegments(["18-24", "45-54"])).toEqual([
      { minAge: 18, maxAge: 24 },
      { minAge: 45, maxAge: 54 },
    ]);
    expect(ageSegments(["unknown"])).toEqual([]);
  });

  it("builds one AudienceDimension per filtered demographic", () => {
    expect(
      audienceDimensions({
        ages: ["55-64", "65+", "unknown"],
        genders: ["female"],
        parentalStatuses: ["parent", "unknown"],
        incomes: ["top_10", "11_20"],
        languages: ["es"],
      }),
    ).toEqual([
      { age: { ageRanges: [{ minAge: 55 }], includeUndetermined: true } },
      { gender: { genders: ["FEMALE"], includeUndetermined: false } },
      { parentalStatus: { parentalStatuses: ["PARENT"], includeUndetermined: true } },
      {
        householdIncome: {
          incomeRanges: ["INCOME_RANGE_90_UP", "INCOME_RANGE_80_90"],
          includeUndetermined: false,
        },
      },
    ]);
  });

  it("builds nothing when there are no demographic filters", () => {
    expect(audienceDimensions(null)).toEqual([]);
    expect(audienceDimensions({ languages: ["en"] })).toEqual([]);
  });

  it("maps languages to Google language constants", () => {
    expect(languageConstants({ languages: ["es", "en"] })).toEqual([
      "languageConstants/1000",
      "languageConstants/1003",
    ]);
    expect(languageConstants(null)).toEqual([]);
  });
});

import {
  AGE_BUCKETS,
  LANGUAGES,
  normalizeAudienceFilters,
  type AgeBucket,
  type AudienceFilters,
} from "./policy.js";

// ---------------------------------------------------------------------------
// AudienceFilters -> Google Ads API (v26) request shapes. Pure, tested.
//
// Demand Gen does demographics through an AUDIENCE resource, not individual
// age_range/gender criteria: the ad group is created with
// audience_setting.use_audience_grouped = true and gets ONE AdGroupCriterion
// whose `audience.audience` points at an Audience whose `dimensions[]` carry
// the age / gender / parental status / household income dimensions.
//   https://developers.google.com/google-ads/api/docs/demand-gen/audience-targeting
//   https://developers.google.com/google-ads/api/reference/rpc/v26/Audience
//   https://developers.google.com/google-ads/api/reference/rpc/v26/AudienceDimension
//   https://developers.google.com/google-ads/api/reference/rpc/v26/AdGroup.AudienceSetting
//
// Language is a plain LanguageInfo criterion — on the ad group for Demand Gen
// campaigns with upgraded targeting (the default), on the campaign otherwise.
//   https://developers.google.com/google-ads/api/reference/rpc/v26/Campaign.DemandGenCampaignSettings
// ---------------------------------------------------------------------------

// AgeSegment: min_age in {18,25,35,45,55,65}, max_age in {24,34,44,54,64} or
// unset for "and over".
// https://developers.google.com/google-ads/api/reference/rpc/v26/AgeSegment
const AGE_BOUNDS: Record<Exclude<AgeBucket, "unknown">, { min: number; max?: number }> = {
  "18-24": { min: 18, max: 24 },
  "25-34": { min: 25, max: 34 },
  "35-44": { min: 35, max: 44 },
  "45-54": { min: 45, max: 54 },
  "55-64": { min: 55, max: 64 },
  "65+": { min: 65 },
};

const GENDER_TYPE = { male: "MALE", female: "FEMALE" } as const;
const PARENTAL_TYPE = { parent: "PARENT", not_parent: "NOT_A_PARENT" } as const;
// IncomeRangeTypeEnum: percentiles of household income, 90_UP = top 10%.
// https://developers.google.com/google-ads/api/reference/rpc/v26/IncomeRangeTypeEnum.IncomeRangeType
const INCOME_TYPE = {
  top_10: "INCOME_RANGE_90_UP",
  "11_20": "INCOME_RANGE_80_90",
  "21_30": "INCOME_RANGE_70_80",
  "31_40": "INCOME_RANGE_60_70",
  "41_50": "INCOME_RANGE_50_60",
  lower_50: "INCOME_RANGE_0_50",
} as const;

export type AgeSegment = { minAge: number; maxAge?: number };

/**
 * Adjacent buckets merge into one contiguous AgeSegment (25-34 + 35-44 ->
 * 25..44), which is what Google's AgeDimension.age_ranges describes.
 */
export function ageSegments(ages: AgeBucket[]): AgeSegment[] {
  const picked = AGE_BUCKETS.filter((b) => b !== "unknown" && ages.includes(b)) as Exclude<
    AgeBucket,
    "unknown"
  >[];
  const order = AGE_BUCKETS.filter((b) => b !== "unknown") as Exclude<AgeBucket, "unknown">[];
  const segments: AgeSegment[] = [];
  let run: Exclude<AgeBucket, "unknown">[] = [];
  const flush = () => {
    if (run.length === 0) return;
    const seg: AgeSegment = { minAge: AGE_BOUNDS[run[0]!].min };
    const max = AGE_BOUNDS[run.at(-1)!].max;
    if (max !== undefined) seg.maxAge = max;
    segments.push(seg);
    run = [];
  };
  for (const b of order) {
    if (picked.includes(b)) run.push(b);
    else flush();
  }
  flush();
  return segments;
}

/**
 * Audience.dimensions[] for the filters, one AudienceDimension per filtered
 * demographic. Empty when no demographic filter is set — the caller then
 * attaches no Audience at all (everyone).
 */
export function audienceDimensions(filters: AudienceFilters | null | undefined): unknown[] {
  const f = normalizeAudienceFilters(filters);
  if (!f) return [];
  const dims: unknown[] = [];
  if (f.ages) {
    dims.push({
      age: { ageRanges: ageSegments(f.ages), includeUndetermined: f.ages.includes("unknown") },
    });
  }
  if (f.genders) {
    dims.push({
      gender: {
        genders: f.genders.filter((g) => g !== "unknown").map((g) => GENDER_TYPE[g as keyof typeof GENDER_TYPE]),
        includeUndetermined: f.genders.includes("unknown"),
      },
    });
  }
  if (f.parentalStatuses) {
    dims.push({
      parentalStatus: {
        parentalStatuses: f.parentalStatuses
          .filter((p) => p !== "unknown")
          .map((p) => PARENTAL_TYPE[p as keyof typeof PARENTAL_TYPE]),
        includeUndetermined: f.parentalStatuses.includes("unknown"),
      },
    });
  }
  if (f.incomes) {
    dims.push({
      householdIncome: {
        incomeRanges: f.incomes
          .filter((i) => i !== "unknown")
          .map((i) => INCOME_TYPE[i as keyof typeof INCOME_TYPE]),
        includeUndetermined: f.incomes.includes("unknown"),
      },
    });
  }
  return dims;
}

/** languageConstants/<id> resource names for the language filter. */
export function languageConstants(filters: AudienceFilters | null | undefined): string[] {
  const f = normalizeAudienceFilters(filters);
  return (f?.languages ?? []).map((code) => `languageConstants/${LANGUAGES[code].criterionId}`);
}

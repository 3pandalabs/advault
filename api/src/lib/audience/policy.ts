import { z } from "zod";

// ---------------------------------------------------------------------------
// Audience filters and the US housing-ads rules. Pure: no db, no fetch, so
// every rule here is unit-tested (policy.test.ts). The Google request shape
// built from these lives in ./google.ts.
//
// Default is NO filters: everyone in the target area. Every filter narrows the
// pool of people who can match, so the same budget buys fewer views; the UI
// says so whenever one is set.
// ---------------------------------------------------------------------------

// Google's own demographic buckets. "unknown" is Google's "undetermined": people
// it has no signal for, which is a large share of YouTube viewers. Leaving it
// unticked quietly removes them.
export const AGE_BUCKETS = ["18-24", "25-34", "35-44", "45-54", "55-64", "65+", "unknown"] as const;
export const GENDERS = ["male", "female", "unknown"] as const;
export const PARENTAL_STATUSES = ["parent", "not_parent", "unknown"] as const;
// Household income percentiles for the advertiser's area, highest first, the
// way Google Ads presents them.
export const INCOME_TIERS = [
  "top_10",
  "11_20",
  "21_30",
  "31_40",
  "41_50",
  "lower_50",
  "unknown",
] as const;

// Google Ads language criterion ids (languageConstants/<id>). Source:
// https://developers.google.com/google-ads/api/data/codes-formats#languages
// A short list of the languages most spoken in US households, not Google's
// full table: this is a picker for a local shop, not an ads console.
export const LANGUAGES = {
  en: { label: "English", criterionId: 1000 },
  es: { label: "Spanish", criterionId: 1003 },
  zh_CN: { label: "Chinese (simplified)", criterionId: 1017 },
  zh_TW: { label: "Chinese (traditional)", criterionId: 1018 },
  tl: { label: "Filipino / Tagalog", criterionId: 1042 },
  vi: { label: "Vietnamese", criterionId: 1040 },
  ar: { label: "Arabic", criterionId: 1019 },
  fr: { label: "French", criterionId: 1002 },
  ko: { label: "Korean", criterionId: 1012 },
  ru: { label: "Russian", criterionId: 1031 },
  pt: { label: "Portuguese", criterionId: 1014 },
  hi: { label: "Hindi", criterionId: 1023 },
} as const;
export type LanguageCode = keyof typeof LANGUAGES;
const LANGUAGE_CODES = Object.keys(LANGUAGES) as [LanguageCode, ...LanguageCode[]];

export type AgeBucket = (typeof AGE_BUCKETS)[number];
export type Gender = (typeof GENDERS)[number];
export type ParentalStatus = (typeof PARENTAL_STATUSES)[number];
export type IncomeTier = (typeof INCOME_TIERS)[number];

function uniqueList<T extends string>(values: readonly [T, ...T[]]) {
  return z
    .array(z.enum(values as [T, ...T[]]))
    .max(values.length)
    .refine((list) => new Set(list).size === list.length, { message: "duplicate value" });
}

/**
 * What the API accepts. Every key optional; an empty or missing list means
 * "everyone" for that dimension. `.strict()` so a typo'd key ("gender") is a
 * 400 rather than a silently ignored filter the advertiser thinks is on.
 */
export const audienceFiltersSchema = z
  .object({
    ages: uniqueList(AGE_BUCKETS),
    genders: uniqueList(GENDERS),
    parentalStatuses: uniqueList(PARENTAL_STATUSES),
    incomes: uniqueList(INCOME_TIERS),
    languages: uniqueList(LANGUAGE_CODES),
  })
  .partial()
  .strict();

export type AudienceFilters = z.infer<typeof audienceFiltersSchema>;

const DEMOGRAPHIC_ORDER = {
  ages: AGE_BUCKETS,
  genders: GENDERS,
  parentalStatuses: PARENTAL_STATUSES,
  incomes: INCOME_TIERS,
} as const;

/**
 * Canonical stored form. Drops empty lists, and drops a demographic list with
 * EVERY option ticked (including unknown) because that is "everyone" and
 * would otherwise attach a pointless Audience at Google. Sorts into Google's
 * bucket order. Returns null when nothing is left — the column's "no filters".
 */
export function normalizeAudienceFilters(
  filters: AudienceFilters | null | undefined,
): AudienceFilters | null {
  if (!filters) return null;
  const out: AudienceFilters = {};
  for (const key of Object.keys(DEMOGRAPHIC_ORDER) as (keyof typeof DEMOGRAPHIC_ORDER)[]) {
    const order = DEMOGRAPHIC_ORDER[key] as readonly string[];
    const list = filters[key] as string[] | undefined;
    if (!list || list.length === 0) continue;
    const set = new Set(list);
    if (order.every((v) => set.has(v))) continue;
    (out as Record<string, string[]>)[key] = order.filter((v) => set.has(v));
  }
  if (filters.languages && filters.languages.length > 0) {
    const set = new Set(filters.languages);
    out.languages = LANGUAGE_CODES.filter((c) => set.has(c));
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** How many filter dimensions are narrowing reach. Drives the UI warning. */
export function activeFilterCount(filters: AudienceFilters | null | undefined): number {
  const n = normalizeAudienceFilters(filters);
  return n ? Object.keys(n).length : 0;
}

// ---------------------------------------------------------------------------
// HOUSING (real estate) — Google's personalized-advertising policy for the US
// and Canada, "Access to opportunities":
//   https://support.google.com/adspolicy/answer/143465
//   https://support.google.com/adspolicy/answer/9997418 (FAQ)
// Housing, employment and credit ads may NOT target or exclude by gender, age,
// parental status, marital status or ZIP code. Radius targeting (≥1 km), city
// and state are allowed.
//
// HOUSEHOLD INCOME IS ALLOWED. The FAQ lists it explicitly under "targeting
// types that will not be restricted" (with homeownership status and
// education), so it stays available to real-estate campaigns here. Language is
// allowed too. Marital status is not a filter this app offers at all.
//
// A housing campaign that breaks this is not rejected at launch by Google — it
// is approved, then disapproved/"not eligible to serve", and the account
// collects a policy strike. So we refuse it ourselves: on save AND at launch.
// ---------------------------------------------------------------------------

/** The category value the web wizard offers. */
export const REAL_ESTATE_CATEGORY = "Real estate";

// Matched on the free-text category too, because older campaigns and the
// "Other" box hold whatever the advertiser typed. Errs towards housing: a
// false positive costs a plumber nothing they asked for (they would have to
// re-categorise), a false negative is a policy strike on the account.
const HOUSING_PATTERN =
  /\b(real[\s-]?estate|realt(or|ors|y)|housing|apartments?|condos?|property\s+management|homes?\s+for\s+(sale|rent)|letting\s+agent|mortgages?)\b/i;

export function isHousingCategory(category: string | null | undefined): boolean {
  return HOUSING_PATTERN.test(category ?? "");
}

/** Filters housing ads may not use. Income and language stay allowed. */
export const HOUSING_RESTRICTED_FILTERS = ["ages", "genders", "parentalStatuses"] as const;

const usState = z.string().regex(/^[A-Z]{2}$/, "must be a 2-letter state code");

/**
 * The listing (or office) address a real-estate campaign targets a radius
 * around. Google geocodes it: a ProximityInfo with an address and no
 * geo_point is resolved to a point by Google.
 * https://developers.google.com/google-ads/api/reference/rpc/v26/ProximityInfo
 * US only — the housing rules this exists for are the US ones.
 */
export const targetAddressSchema = z
  .object({
    street: z.string().trim().min(1).max(200),
    city: z.string().trim().min(1).max(100),
    state: usState,
    postalCode: z.string().regex(/^\d{5}$/, "must be a 5-digit US ZIP"),
  })
  .strict();

export type TargetAddress = z.infer<typeof targetAddressSchema>;

export type TargetingViolation =
  | "housing_demographics_not_allowed"
  | "housing_zip_targeting_not_allowed"
  | "listing_address_required"
  | "zip_codes_required";

export const TARGETING_VIOLATION_DETAIL: Record<TargetingViolation, string> = {
  housing_demographics_not_allowed:
    "Housing ads in the US can't target by age, gender or family status (Google policy). Remove those filters.",
  housing_zip_targeting_not_allowed:
    "Housing ads in the US can't target by ZIP code (Google policy). Real-estate campaigns target a distance around the listing instead.",
  listing_address_required: "Real-estate campaigns need the listing address to target a distance around.",
  zip_codes_required: "Add at least one ZIP or PIN code to target.",
};

export type TargetingInput = {
  businessCategory: string;
  targetZipCodes: string[] | null | undefined;
  targetAddress: TargetAddress | null | undefined;
  audienceFilters: AudienceFilters | null | undefined;
};

/**
 * Every reason this campaign's targeting can't be saved or launched. Empty
 * means fine. Called by POST/PATCH /campaigns and again by launch — the
 * launch check is defence in depth against rows written before this rule (or
 * by hand), since launch is the step that actually reaches Google.
 */
export function targetingViolations(c: TargetingInput): TargetingViolation[] {
  const out: TargetingViolation[] = [];
  const zips = c.targetZipCodes ?? [];
  if (isHousingCategory(c.businessCategory)) {
    const f = normalizeAudienceFilters(c.audienceFilters);
    if (f && HOUSING_RESTRICTED_FILTERS.some((k) => f[k] && f[k]!.length > 0)) {
      out.push("housing_demographics_not_allowed");
    }
    if (zips.length > 0) out.push("housing_zip_targeting_not_allowed");
    if (!c.targetAddress) out.push("listing_address_required");
  } else if (zips.length === 0) {
    out.push("zip_codes_required");
  }
  return out;
}

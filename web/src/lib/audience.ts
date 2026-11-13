// Browser mirror of api/src/lib/audience/policy.ts. The API is the real
// boundary (it refuses housing demographics on save AND at launch); this copy
// exists so the form can hide what would be refused instead of failing after
// submit. Keep the value lists and the housing pattern in step with the API.

/** Business categories offered in signup and the campaign wizard. */
// Audience filters (age, gender, parental status, income, language) are parked
// for MVP2 (2026-11-13): untested against the live Google Ads API, and at $1/day
// every filter costs reach. The API still accepts and enforces them; this only
// hides the UI. Flip to true to bring them back.
export const AUDIENCE_FILTERS_ENABLED = false;

export const CATEGORIES = [
  "Plumbing",
  "Electrical",
  "HVAC",
  "Dentistry",
  "Restaurant",
  "Real estate",
  "Landscaping",
  "Auto repair",
  "Cleaning services",
  "Other",
] as const;

export const REAL_ESTATE_CATEGORY = "Real estate";

const HOUSING_PATTERN =
  /\b(real[\s-]?estate|realt(or|ors|y)|housing|apartments?|condos?|property\s+management|homes?\s+for\s+(sale|rent)|letting\s+agent|mortgages?)\b/i;

export function isHousingCategory(category: string | null | undefined): boolean {
  return HOUSING_PATTERN.test(category ?? "");
}

export const AGE_OPTIONS = [
  { value: "18-24", label: "18–24" },
  { value: "25-34", label: "25–34" },
  { value: "35-44", label: "35–44" },
  { value: "45-54", label: "45–54" },
  { value: "55-64", label: "55–64" },
  { value: "65+", label: "65+" },
  { value: "unknown", label: "Unknown" },
] as const;

export const GENDER_OPTIONS = [
  { value: "male", label: "Male" },
  { value: "female", label: "Female" },
  { value: "unknown", label: "Unknown" },
] as const;

export const PARENTAL_OPTIONS = [
  { value: "parent", label: "Parents" },
  { value: "not_parent", label: "Not parents" },
  { value: "unknown", label: "Unknown" },
] as const;

export const INCOME_OPTIONS = [
  { value: "top_10", label: "Top 10%" },
  { value: "11_20", label: "11–20%" },
  { value: "21_30", label: "21–30%" },
  { value: "31_40", label: "31–40%" },
  { value: "41_50", label: "41–50%" },
  { value: "lower_50", label: "Lower 50%" },
  { value: "unknown", label: "Unknown" },
] as const;

export const LANGUAGE_OPTIONS = [
  { value: "en", label: "English" },
  { value: "es", label: "Spanish" },
  { value: "zh_CN", label: "Chinese (simplified)" },
  { value: "zh_TW", label: "Chinese (traditional)" },
  { value: "tl", label: "Filipino / Tagalog" },
  { value: "vi", label: "Vietnamese" },
  { value: "ar", label: "Arabic" },
  { value: "fr", label: "French" },
  { value: "ko", label: "Korean" },
  { value: "ru", label: "Russian" },
  { value: "pt", label: "Portuguese" },
  { value: "hi", label: "Hindi" },
] as const;

type Values<T extends readonly { value: string }[]> = T[number]["value"];

export type AudienceFilters = {
  ages?: Values<typeof AGE_OPTIONS>[];
  genders?: Values<typeof GENDER_OPTIONS>[];
  parentalStatuses?: Values<typeof PARENTAL_OPTIONS>[];
  incomes?: Values<typeof INCOME_OPTIONS>[];
  languages?: Values<typeof LANGUAGE_OPTIONS>[];
};

export type AudienceFilterKey = keyof AudienceFilters;

/** Demographics US housing ads may not use. Income and language are allowed. */
export const HOUSING_RESTRICTED: AudienceFilterKey[] = ["ages", "genders", "parentalStatuses"];

export const FILTER_SECTIONS: {
  key: AudienceFilterKey;
  title: string;
  options: readonly { value: string; label: string }[];
}[] = [
  { key: "ages", title: "Age", options: AGE_OPTIONS },
  { key: "genders", title: "Gender", options: GENDER_OPTIONS },
  { key: "parentalStatuses", title: "Parental status", options: PARENTAL_OPTIONS },
  { key: "incomes", title: "Household income", options: INCOME_OPTIONS },
  { key: "languages", title: "Language", options: LANGUAGE_OPTIONS },
];

/** Is this dimension actually narrowing reach? (empty or all-ticked = everyone) */
export function isActive(key: AudienceFilterKey, filters: AudienceFilters): boolean {
  const list = (filters[key] ?? []) as string[];
  if (list.length === 0) return false;
  if (key === "languages") return true;
  const section = FILTER_SECTIONS.find((s) => s.key === key)!;
  return !section.options.every((o) => list.includes(o.value));
}

/**
 * What to send: drops everyone-equivalent dimensions, and for a housing
 * campaign drops the restricted ones entirely. null = no filters.
 */
export function filtersForSave(filters: AudienceFilters, housing: boolean): AudienceFilters | null {
  const out: AudienceFilters = {};
  for (const s of FILTER_SECTIONS) {
    if (housing && HOUSING_RESTRICTED.includes(s.key)) continue;
    if (isActive(s.key, filters)) (out as Record<string, string[]>)[s.key] = filters[s.key] as string[];
  }
  return Object.keys(out).length > 0 ? out : null;
}

export function summarize(key: AudienceFilterKey, filters: AudienceFilters | null | undefined): string {
  if (!filters || !isActive(key, filters)) return "Everyone";
  const section = FILTER_SECTIONS.find((s) => s.key === key)!;
  const list = filters[key] as string[];
  return section.options
    .filter((o) => list.includes(o.value))
    .map((o) => o.label)
    .join(", ");
}

export type TargetAddress = { street: string; city: string; state: string; postalCode: string };

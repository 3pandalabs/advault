// Per-category features (2026-11-20): one key per wizard category, so every
// category extra (seasons, schedule presets, badges, plan offers, claim
// checks, category extras) is configured by ONE table per mechanism instead
// of ten one-off features. Pure, tested (key.test.ts).
//
// Mirrored for the browser in web/src/lib/categories/key.ts: the block
// between the <shared> markers is kept word for word by mirror.test.ts.

// <shared>
export const CATEGORY_KEYS = [
  "plumbing",
  "electrical",
  "hvac",
  "dentistry",
  "restaurant",
  "landscaping",
  "auto",
  "carWash",
  "cleaning",
  "realEstate",
] as const;
export type CategoryKey = (typeof CATEGORY_KEYS)[number];

/** The wizard's preset categories (web/src/lib/audience.ts CATEGORIES). */
const PRESET_KEYS: Record<string, CategoryKey> = {
  Plumbing: "plumbing",
  Electrical: "electrical",
  HVAC: "hvac",
  Dentistry: "dentistry",
  Restaurant: "restaurant",
  Landscaping: "landscaping",
  "Auto repair": "auto",
  "Car wash": "carWash",
  "Cleaning services": "cleaning",
  "Real estate": "realEstate",
};

// Typed-in ("Other") categories, checked in this order: the first match wins,
// so "dental cleaning" is dentistry, "auto electrical" is auto and "auto detailing" is carWash.
const KEY_PATTERNS: [CategoryKey, RegExp][] = [
  ["realEstate", /\b(real[\s-]?estate|realt(or|ors|y)|homes?\s+for\s+sale|property\s+sales?)\b/i],
  ["dentistry", /\b(dent(al|ist|istry|ists)|orthodont\w*|teeth|tooth)\b/i],
  ["restaurant", /\b(restaurants?|cafe|café|diner|bistro|pizz\w*|grill|eatery|taqueria|bbq|barbecue|sushi|catering|food truck|kitchen and bar)\b/i],
  ["carWash", /\b((car|auto|truck|vehicle)[\s-]?wash\w*|(car|auto|vehicle|mobile) (detail\w*|cleaning)|detail(ing|ers?))\b/i],
  ["auto", /\b(auto|automotive|mechanics?|car repair|tires?|brakes?|oil change|body ?shop|collision|transmission|garage)\b/i],
  ["hvac", /\b(hvac|heating|air[\s-]condition\w*|furnaces?|heat pumps?)\b/i],
  ["plumbing", /\b(plumb\w*|drains?|sewer|water heaters?)\b/i],
  ["electrical", /\b(electric(al|ian|ians)?|wiring)\b/i],
  ["landscaping", /\b(landscap\w*|lawns?|yard|garden(ing|ers?)?|mow(ing)?|tree (service|care|removal)|snow (removal|plowing))\b/i],
  ["cleaning", /\b(clean(ing|ers?)|maids?|janitorial|housekeeping)\b/i],
];

/** The category's key, or null for a category with no per-category extras. */
export function categoryKey(category: string | null | undefined): CategoryKey | null {
  const c = (category ?? "").trim();
  if (!c) return null;
  if (PRESET_KEYS[c]) return PRESET_KEYS[c];
  for (const [key, re] of KEY_PATTERNS) if (re.test(c)) return key;
  return null;
}

export type Market = "US" | "IN";

/** Campaigns are one country: INR = India, everything else is sold as US. */
export function marketFor(currencyCode: string | null | undefined): Market {
  return currencyCode === "INR" ? "IN" : "US";
}
// </shared>

// Browser mirror of api/src/lib/categories/badges.ts. The API is the real
// boundary; the block between the <shared> markers is kept word for word
// by api/src/lib/categories/mirror.test.ts. Edit the API copy, then this.

import type { CategoryKey } from "./key";

// <shared>
export type BadgeId =
  | "license_number"
  | "licensed_insured"
  | "background_checked"
  | "warranty_12mo"
  | "ase_certified"
  | "pesticide_license"
  | "upfront_pricing"
  | "insurance_accepted"
  | "financing"
  | "emergency_24_7";

export type BadgeDef = {
  id: BadgeId;
  /** The checkbox label. */
  label: string;
  /** The chip on the video (short, fits the end card). */
  chip: string;
};

export const BADGES: Record<BadgeId, BadgeDef> = {
  license_number: { id: "license_number", label: "License number (shown in the ad)", chip: "LIC #" },
  licensed_insured: { id: "licensed_insured", label: "Licensed & insured", chip: "Licensed & insured" },
  background_checked: { id: "background_checked", label: "Background-checked staff", chip: "Background-checked" },
  warranty_12mo: { id: "warranty_12mo", label: "12-month warranty on our work", chip: "12-month warranty" },
  ase_certified: { id: "ase_certified", label: "ASE certified mechanics", chip: "ASE certified" },
  pesticide_license: { id: "pesticide_license", label: "Licensed pesticide applicator", chip: "Licensed applicator" },
  upfront_pricing: { id: "upfront_pricing", label: "Upfront pricing (price agreed before work)", chip: "Upfront pricing" },
  insurance_accepted: { id: "insurance_accepted", label: "Most insurance accepted", chip: "Most insurance accepted" },
  financing: { id: "financing", label: "Financing available", chip: "Financing available" },
  emergency_24_7: { id: "emergency_24_7", label: "24/7 emergency service (you answer at night)", chip: "24/7 emergency service" },
};

const TRADE: readonly BadgeId[] = [
  "license_number",
  "licensed_insured",
  "background_checked",
  "warranty_12mo",
  "upfront_pricing",
  "financing",
  "emergency_24_7",
];

export const BADGES_BY_CATEGORY: Record<CategoryKey, readonly BadgeId[]> = {
  plumbing: TRADE,
  electrical: TRADE,
  hvac: TRADE,
  dentistry: ["insurance_accepted", "financing"],
  restaurant: [],
  landscaping: ["license_number", "licensed_insured", "pesticide_license", "background_checked", "upfront_pricing"],
  auto: ["ase_certified", "warranty_12mo", "upfront_pricing", "financing"],
  cleaning: ["licensed_insured", "background_checked", "upfront_pricing"],
  realEstate: ["license_number"],
};

/** Typed-in categories with no key still get the generic ones. */
export const GENERIC_BADGES: readonly BadgeId[] = ["licensed_insured", "upfront_pricing", "financing"];

/** At most this many chips fit the end card. */
export const MAX_BADGES = 4;

export function badgeOptions(key: CategoryKey | null): readonly BadgeId[] {
  return key ? BADGES_BY_CATEGORY[key] : GENERIC_BADGES;
}

export const BADGE_ATTESTATION = "These are true for my business today.";

export type BadgeSelection = { ids: BadgeId[]; licenseNumber?: string | null };

export type BadgeViolation =
  | "badge_not_for_category"
  | "badge_attestation_required"
  | "badge_license_number_required"
  | "badge_license_number_invalid"
  | "badge_too_many"
  | "badge_duplicate";

export const BADGE_DETAIL: Record<BadgeViolation, string> = {
  badge_not_for_category: "One of those badges is not offered for your kind of business.",
  badge_attestation_required: "Tick the box to confirm these are true for your business today.",
  badge_license_number_required: "Type your license number, or untick it.",
  badge_license_number_invalid: "A license number is letters, numbers and dashes, up to 20 characters.",
  badge_too_many: `Pick up to ${MAX_BADGES}. More would not fit on the video.`,
  badge_duplicate: "Each badge can be picked once.",
};

const LICENSE_RE = /^[A-Za-z0-9][A-Za-z0-9 -]{0,19}$/;

/** The first reason this selection can't be saved, or null. An empty list always saves (removes them). */
export function badgeViolation(key: CategoryKey | null, sel: BadgeSelection, attested: boolean): BadgeViolation | null {
  if (sel.ids.length === 0) return null;
  if (new Set(sel.ids).size !== sel.ids.length) return "badge_duplicate";
  if (sel.ids.length > MAX_BADGES) return "badge_too_many";
  const allowed = badgeOptions(key);
  if (sel.ids.some((id) => !allowed.includes(id))) return "badge_not_for_category";
  if (sel.ids.includes("license_number")) {
    const n = (sel.licenseNumber ?? "").trim();
    if (!n) return "badge_license_number_required";
    if (!LICENSE_RE.test(n)) return "badge_license_number_invalid";
  }
  if (!attested) return "badge_attestation_required";
  return null;
}

/** The chips for the video, in the order picked: "LIC #12345", "Licensed & insured". */
export function badgeChips(sel: BadgeSelection | null | undefined): string[] {
  if (!sel) return [];
  return sel.ids.flatMap((id) => {
    const b = BADGES[id];
    if (!b) return [];
    if (id === "license_number") {
      const n = (sel.licenseNumber ?? "").trim();
      return n ? [`${b.chip}${n}`.slice(0, 28)] : [];
    }
    return [b.chip];
  });
}
// </shared>

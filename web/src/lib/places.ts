// "Find my business on Google": Google's primaryType -> the wizard's category
// list (lib/audience CATEGORIES). null = no confident match; keep the owner's.
const RULES: [RegExp, string][] = [
  [/car_wash/, "Car wash"],
  [/plumb/, "Plumbing"],
  [/electric/, "Electrical"],
  [/hvac|heating|air_condition/, "HVAC"],
  [/dent/, "Dentistry"],
  [/real_estate/, "Real estate"],
  [/landscap|lawn|garden/, "Landscaping"],
  [/car_repair|auto|mechanic|tire|car_dealer/, "Auto repair"],
  [/clean|maid|janitor/, "Cleaning services"],
  [/restaurant|cafe|coffee|bakery|pizza|diner|food|meal|bar_and_grill|deli/, "Restaurant"],
];

export function categoryFromPlaceType(primaryType: string | null | undefined): string | null {
  if (!primaryType) return null;
  const t = primaryType.toLowerCase();
  return RULES.find(([re]) => re.test(t))?.[1] ?? null;
}

/** "1 Main St, Springfield, IL 62701, USA" -> street, city, state for a housing address. */
export function splitUsAddress(address: string): { street: string; city: string; state: string } {
  const parts = address.split(",").map((p) => p.trim());
  const stateZip = parts.find((p) => /^[A-Z]{2}\s+\d{5}/.test(p)) ?? "";
  return { street: parts[0] ?? "", city: parts.length >= 3 ? parts[parts.length - 3]! : "", state: stateZip.slice(0, 2) };
}

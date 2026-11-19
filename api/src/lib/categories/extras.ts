// Category extras (2026-11-20, migration 0040): the small per-category
// features that are neither seasons, badges nor plan offers.
//   Restaurant  — a menu-item spotlight (one dish, its photo, its price) and
//                 an order / reserve link.
//   Auto repair — the makes they service, shown in the ad.
//   Landscaping — "ads around the streets we already work": the ZIPs of
//                 existing customers become the ad's ZIPs, with neighbor-price
//                 copy.
//   Electrical  — upgrade offer presets (EV charger, panel, generator, solar).
//   Cleaning    — the move-out / move-in preset.
// (Real estate's open house and "just sold" ads live in lib/realty.)
// Stored on campaigns.category_extras; the route is routes/categoryExtras.ts.
// Pure, tested (extras.test.ts).
//
// Mirrored for the browser in web/src/lib/categories/extras.ts (the block
// between the <shared> markers, word for word, mirror.test.ts).

import type { CategoryKey } from "./key.js";

// <shared>
export type CategoryExtras = {
  /** Restaurant: one dish to feature. */
  spotlight?: { dish: string; price?: string | null; assetId?: string | null } | null;
  /** Restaurant: where to order or book. */
  orderUrl?: string | null;
  /** Auto repair: the makes they service. */
  makes?: string[] | null;
  /** Landscaping: ZIPs where they already have customers. */
  neighborZips?: string[] | null;
};

/** Which extras each category gets (the card shows only these). */
export const EXTRAS_BY_CATEGORY: Partial<Record<CategoryKey, readonly (keyof CategoryExtras)[]>> = {
  restaurant: ["spotlight", "orderUrl"],
  auto: ["makes"],
  landscaping: ["neighborZips"],
};

export function extrasFor(key: CategoryKey | null): readonly (keyof CategoryExtras)[] {
  return key ? (EXTRAS_BY_CATEGORY[key] ?? []) : [];
}

export const COMMON_MAKES = [
  "Toyota",
  "Honda",
  "Ford",
  "Chevrolet",
  "Nissan",
  "Hyundai",
  "Kia",
  "Subaru",
  "Jeep",
  "Ram",
  "GMC",
  "Volkswagen",
  "BMW",
  "Mercedes-Benz",
  "Audi",
  "Lexus",
  "Mazda",
  "Tesla",
] as const;

export const MAX_MAKES = 12;
export const MAX_NEIGHBOR_ZIPS = 50;

export type ExtrasProblem =
  | "extras_not_for_category"
  | "spotlight_dish_required"
  | "spotlight_too_long"
  | "order_url_invalid"
  | "makes_invalid"
  | "neighbor_zips_invalid";

export const EXTRAS_DETAIL: Record<ExtrasProblem, string> = {
  extras_not_for_category: "That extra is not offered for your kind of business.",
  spotlight_dish_required: "Name the dish you want to feature.",
  spotlight_too_long: "Keep the dish name under 40 characters and the price under 12.",
  order_url_invalid: "The order or booking link must start with http:// or https://.",
  makes_invalid: `Pick up to ${MAX_MAKES} makes, each under 20 characters.`,
  neighbor_zips_invalid: `Use up to ${MAX_NEIGHBOR_ZIPS} 5-digit ZIP or 6-digit PIN codes, all from one country.`,
};

const ZIP_RE = /^\d{5}$|^\d{6}$/;

/** Splits typed ZIPs ("08817, 08820 08837") into unique codes, in order. */
export function parseZips(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map((z) => z.trim()).filter(Boolean))];
}

/** The first reason these extras can't be saved, or null. Empty/absent fields always save. */
export function extrasProblem(key: CategoryKey | null, e: CategoryExtras): ExtrasProblem | null {
  const allowed = extrasFor(key);
  const used = (Object.keys(e) as (keyof CategoryExtras)[]).filter((k) => {
    const v = e[k];
    return v != null && !(Array.isArray(v) && v.length === 0) && v !== "";
  });
  if (used.some((k) => !allowed.includes(k))) return "extras_not_for_category";
  if (e.spotlight) {
    if (!e.spotlight.dish.trim()) return "spotlight_dish_required";
    if (e.spotlight.dish.trim().length > 40 || (e.spotlight.price ?? "").trim().length > 12) return "spotlight_too_long";
  }
  if (e.orderUrl && !/^https?:\/\/[^\s]+\.[^\s]+/i.test(e.orderUrl.trim())) return "order_url_invalid";
  if (e.makes && (e.makes.length > MAX_MAKES || e.makes.some((m) => !m.trim() || m.trim().length > 20))) return "makes_invalid";
  if (e.neighborZips) {
    const z = e.neighborZips;
    if (z.length > MAX_NEIGHBOR_ZIPS || z.some((x) => !ZIP_RE.test(x)) || new Set(z.map((x) => x.length)).size > 1) {
      return "neighbor_zips_invalid";
    }
  }
  return null;
}

/** Facts for the script writer (the owner's own claims). */
export function extrasFacts(key: CategoryKey | null, e: CategoryExtras | null | undefined): string[] {
  if (!e) return [];
  const allowed = extrasFor(key);
  const facts: string[] = [];
  if (allowed.includes("spotlight") && e.spotlight?.dish.trim()) {
    const price = e.spotlight.price?.trim();
    facts.push(`Featured dish: ${e.spotlight.dish.trim()}${price ? `, ${price}` : ""}. Make it the star of the ad.`);
  }
  if (allowed.includes("makes") && e.makes?.length) facts.push(`Makes we service: ${e.makes.join(", ")}.`);
  return facts;
}

/** One line for the ad's end card ("Try our Margherita · $14", "We service Toyota · Honda · Ford"), or null. */
export function extrasEndCardLine(key: CategoryKey | null, e: CategoryExtras | null | undefined): string | null {
  if (!e) return null;
  const allowed = extrasFor(key);
  if (allowed.includes("spotlight") && e.spotlight?.dish.trim()) {
    const price = e.spotlight.price?.trim();
    return `Try our ${e.spotlight.dish.trim()}${price ? ` · ${price}` : ""}`.slice(0, 60);
  }
  if (allowed.includes("makes") && e.makes?.length) {
    let line = "We service";
    for (const [i, m] of e.makes.entries()) {
      const next = `${line}${i === 0 ? " " : " · "}${m.trim()}`;
      if (next.length > 56) return `${line} + more`;
      line = next;
    }
    return line;
  }
  return null;
}

/** Landscaping: "Neighbor price: $10 off for homes near the yards we already care for." */
export function neighborOfferText(deal: string): string | null {
  const d = deal.trim().replace(/\.$/, "");
  if (!d) return null;
  return `Neighbor price: ${d} for homes near the yards we already care for. We're on your street every week.`;
}

export type OfferPreset = { id: string; label: string; offer: string; callToAction: string };

/** One-tap offers per category (the owner edits the prices before saving). */
export const OFFER_PRESETS: Partial<Record<CategoryKey, readonly OfferPreset[]>> = {
  electrical: [
    {
      id: "ev-charger",
      label: "EV charger",
      offer: "Home EV charger installs from $599. Charge overnight in your own garage. Licensed electricians, free estimates.",
      callToAction: "Get a free estimate",
    },
    {
      id: "panel",
      label: "Panel upgrade",
      offer: "Electrical panel upgrades. Power for your new kitchen, EV or heat pump. Free estimates.",
      callToAction: "Get a free estimate",
    },
    {
      id: "generator",
      label: "Generator",
      offer: "Home standby generators, installed and connected. Keep the lights on in the next outage. Free estimates.",
      callToAction: "Get a free estimate",
    },
    {
      id: "solar",
      label: "Solar hookup",
      offer: "Solar and battery hookups by licensed electricians. Panel and wiring checked first. Free estimates.",
      callToAction: "Get a free estimate",
    },
  ],
  cleaning: [
    {
      id: "move-out-in",
      label: "Move-out / move-in",
      offer: "Move-out and move-in cleaning from $199. Inside cabinets, appliances and floors. Help get your deposit back.",
      callToAction: "Book a clean",
    },
  ],
};

export function offerPresets(key: CategoryKey | null): readonly OfferPreset[] {
  return key ? (OFFER_PRESETS[key] ?? []) : [];
}
// </shared>

/**
 * API only: the photos for the ad with the restaurant's featured dish first
 * (moved to the front if already chosen, else added), at most `max`.
 */
export function withSpotlightPhoto(assetIds: readonly string[], spotlightId: string | null | undefined, max = 5): string[] {
  if (!spotlightId) return [...assetIds];
  return [spotlightId, ...assetIds.filter((id) => id !== spotlightId)].slice(0, max);
}

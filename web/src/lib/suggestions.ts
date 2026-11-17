// One-tap suggestions for text boxes (components/SuggestionChips). Pure: built
// only from what the page already has (the business, its category, the
// campaign), never fetched. The owner always sees and can edit the text after
// tapping, so these are starting points, not claims made on their behalf.

import { isHousingCategory } from "@/lib/audience";

/** Call-to-action options per category; the API allows any 1-40 chars. */
const CTA_BY_CATEGORY: Record<string, string[]> = {
  Plumbing: ["Call now", "Get a free quote", "Book a plumber"],
  Electrical: ["Call now", "Get a free estimate", "Book an electrician"],
  HVAC: ["Call now", "Book a tune-up", "Get a free quote"],
  Dentistry: ["Book an appointment", "Call now", "Book your cleaning"],
  Restaurant: ["Order now", "Reserve a table", "Call now"],
  Landscaping: ["Get a free quote", "Call now", "Book a cleanup"],
  "Auto repair": ["Book a service", "Call now", "Get a free quote"],
  "Cleaning services": ["Book a clean", "Get a free quote", "Call now"],
};

export function callToActionSuggestions(category: string, isListing: boolean): string[] {
  if (isHousingCategory(category)) {
    return isListing
      ? ["Schedule a tour", "Call now", "See the home"]
      : ["Get a free home valuation", "Call now", "Book a consultation"];
  }
  return CTA_BY_CATEGORY[category] ?? ["Call now", "Get a free quote", "Visit us today"];
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Campaign-name ideas from the business name (only the owner sees the name). */
export function campaignNameSuggestions(businessName: string, now: Date = new Date()): string[] {
  const name = businessName.trim();
  if (!name) return [];
  return [`${name} — local reach`, `${name} — ${MONTHS[now.getMonth()]} ${now.getFullYear()}`];
}

/** "Austin, TX" from a campaign's listing address, or null. */
export function townFromAddress(a: { city?: string | null; state?: string | null } | null | undefined): string | null {
  const city = a?.city?.trim();
  if (!city) return null;
  const state = a?.state?.trim();
  return state ? `${city}, ${state.toUpperCase()}` : city;
}

/** Opening-hours patterns; the owner picks the closest and edits. */
export function openingHoursSuggestions(category: string): string[] {
  if (category === "Restaurant") return ["Daily 11am-10pm", "Tue-Sun 11am-9pm", "Mon-Sat 11am-10pm, Sun 12pm-8pm"];
  if (category === "Plumbing" || category === "HVAC" || category === "Electrical") {
    return ["Mon-Fri 8am-6pm, Sat 9am-2pm", "Open 24/7 for emergencies", "Mon-Sat 7am-7pm"];
  }
  if (category === "Dentistry") return ["Mon-Fri 8am-5pm", "Mon-Thu 8am-7pm, Sat 9am-2pm", "Mon-Fri 9am-6pm"];
  return ["Mon-Fri 8am-6pm, Sat 9am-2pm", "Mon-Sat 9am-6pm", "Mon-Fri 9am-5pm"];
}

/**
 * The cinematic description from the chosen campaign: who they are, where,
 * and the offer they already wrote. Null when it would be under the 20-char
 * minimum the order needs.
 */
export function cinematicDescription(c: {
  businessName: string;
  businessCategory: string;
  offerDetails: string | null;
  targetAddress?: { city?: string | null; state?: string | null } | null;
}): string | null {
  const name = c.businessName.trim();
  if (!name) return null;
  const category = c.businessCategory.trim();
  const town = townFromAddress(c.targetAddress ?? null);
  let s = `We're ${name}`;
  if (category && category !== "Other") s += `, a local ${category.toLowerCase()} business`;
  if (town) s += ` in ${town}`;
  s += ".";
  const offer = c.offerDetails?.trim();
  if (offer) s += ` ${offer}`;
  return s.length >= 20 ? s.slice(0, 2000) : null;
}

/** Common reasons an uploaded video is rejected (admin review queue). */
export const REJECT_REASON_SUGGESTIONS = [
  "The background music is a copyrighted song.",
  "The video is too blurry or low-resolution to run as an ad.",
  "The video makes a claim we can't run (a price or result that isn't shown to be true).",
];

/** A month's offer when the page knows nothing about the business. */
export const GENERIC_MONTHLY_OFFER = "10% off for new customers until the end of the month";

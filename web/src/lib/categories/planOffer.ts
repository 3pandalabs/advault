// Browser mirror of api/src/lib/categories/planOffer.ts. The API is the real
// boundary; the block between the <shared> markers is kept word for word
// by api/src/lib/categories/mirror.test.ts. Edit the API copy, then this.

import type { CategoryKey } from "./key";

// <shared>
export const PLAN_OFFER_CATEGORIES: readonly CategoryKey[] = ["landscaping", "cleaning", "hvac", "carWash"];

export type PlanCadence = "visit" | "month" | "season";
export type FirstVisitDeal = { kind: "percent"; value: number } | { kind: "amount"; value: number } | { kind: "free" };

export type PlanOfferInput = {
  /** "Weekly mowing", "Every-other-week home cleaning". */
  service: string;
  cadence: PlanCadence;
  /** Whole currency units (dollars or rupees), > 0. */
  price: number;
  currencyCode: string;
  firstVisit?: FirstVisitDeal | null;
};

/** The default service name per category (the owner can change it). */
export const PLAN_SERVICE: Partial<Record<CategoryKey, string>> = {
  landscaping: "Weekly mowing",
  cleaning: "Every-other-week home cleaning",
  hvac: "Heating and cooling maintenance plan",
  carWash: "Unlimited car washes",
};

const CADENCE_TEXT: Record<PlanCadence, string> = {
  visit: "a visit",
  month: "a month",
  season: "a season",
};

function money(n: number, currencyCode: string): string {
  const symbol = currencyCode === "INR" ? "₹" : "$";
  const whole = Number.isInteger(n);
  return `${symbol}${whole ? n.toLocaleString("en-US") : n.toFixed(2)}`;
}

export type PlanOfferProblem = "plan_service_required" | "plan_price_invalid" | "plan_deal_invalid";

export const PLAN_OFFER_DETAIL: Record<PlanOfferProblem, string> = {
  plan_service_required: "Say what the plan is, for example “Weekly mowing”.",
  plan_price_invalid: "Enter a price above zero.",
  plan_deal_invalid: "The first-visit deal must be less than the price (1 to 100% off).",
};

export function planOfferProblem(input: PlanOfferInput): PlanOfferProblem | null {
  if (!input.service.trim()) return "plan_service_required";
  if (!Number.isFinite(input.price) || input.price <= 0 || input.price > 100_000) return "plan_price_invalid";
  const d = input.firstVisit;
  if (d?.kind === "percent" && !(d.value >= 1 && d.value <= 100 && Number.isInteger(d.value))) return "plan_deal_invalid";
  if (d?.kind === "amount" && !(d.value > 0 && d.value < input.price)) return "plan_deal_invalid";
  return null;
}

/**
 * "Weekly mowing from $35 a visit. First visit 50% off." The price is "from"
 * because yard and home sizes differ. Null when the input has a problem.
 */
export function planOfferText(input: PlanOfferInput): string | null {
  if (planOfferProblem(input)) return null;
  const service = input.service.trim().replace(/\.$/, "");
  const parts = [`${service} from ${money(input.price, input.currencyCode)} ${CADENCE_TEXT[input.cadence]}.`];
  const d = input.firstVisit;
  if (d?.kind === "free" || (d?.kind === "percent" && d.value === 100)) parts.push("First visit free.");
  else if (d?.kind === "percent") parts.push(`First visit ${d.value}% off.`);
  else if (d?.kind === "amount") parts.push(`${money(d.value, input.currencyCode)} off your first visit.`);
  return parts.join(" ");
}
// </shared>

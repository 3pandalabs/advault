import { estimateReach, type Currency } from "../pricing/index.js";

/**
 * The one estimate line under the top-up picker (owner, 2026-11-19): "Your ad
 * would be shown about X–Y times to people in your area." for the chosen
 * amount. Times shown is estimateReach() (CPM-based impressions, rounded to
 * 500): NOT views and NOT unique people. No days or clicks in that line.
 * Mirrored in web/src/lib/budget.ts (timesShownEstimate).
 */
export function timesShownEstimate(amountMinor: number, currency: Currency): { low: number; high: number } {
  const r = estimateReach(Math.max(amountMinor, 0), currency);
  return { low: r.low, high: r.high };
}

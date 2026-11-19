import { estimateReach, type Currency } from "../pricing/index.js";
import { daysOfBudget, estimateClicks } from "./runway.js";

/**
 * Everything the top-up picker's estimate line says, for one amount. Times
 * shown is estimateReach() (impressions, from CPM ranges: NOT views and NOT
 * unique people). Mirrored in web/src/lib/budget.ts (topupEstimate).
 */
export function topupEstimate(amountMinor: number, dailyMinor: number, currency: Currency) {
  const shown = estimateReach(Math.max(amountMinor, 0), currency);
  return {
    days: daysOfBudget(amountMinor, dailyMinor),
    shownLow: shown.low,
    shownHigh: shown.high,
    clicks: estimateClicks(amountMinor, currency),
  };
}

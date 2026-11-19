// How a month's ad budget is spread over the month, mirrored from
// api/src/lib/schedule/spread.ts (same arithmetic, keep them in step).
// Google spends at least $5 a day on a Demand Gen ad (and some days a little
// more), so $35 buys about 6 days of showing; the ad schedule spreads those
// days across the month. At about 2 days a week the $35 usually runs out in
// week 3 or 4, so the copy says "for most of the month", never "all month".

export const SPREAD_WEEKS_PER_MONTH = 4.35;

/** Days a week the ad shows when this month's budget is spread over the month at the daily budget. 0 when no budget. */
export function spreadDaysPerWeek(monthlyBudgetCents: number, dailyCents = 500): number {
  if (monthlyBudgetCents <= 0 || dailyCents <= 0) return 0;
  return Math.min(7, Math.max(1, Math.round(monthlyBudgetCents / dailyCents / SPREAD_WEEKS_PER_MONTH)));
}

/** Google can spend a little over the daily budget on a given day; copy-only
 *  allowance so the "covers about N days" line is not optimistic. Web only. */
const OVERSPEND = 1.15;

/** Days of showing a budget buys at the daily budget (Google's $5 minimum, plus
 *  its occasional overspend): $35 -> 6, $70 -> 12, $100 -> 17. */
export function showingDays(budgetCents: number, dailyCents = 500): number {
  if (budgetCents <= 0 || dailyCents <= 0) return 0;
  return Math.max(1, Math.floor(budgetCents / (dailyCents * OVERSPEND)));
}

/** "Your ad shows about 2 days a week for most of the month." ($35 -> 2, $50 -> 2,
 *  $70 -> 3, $100 -> 5, 7 -> most days.) Never "all month": the budget usually
 *  runs out in week 3 or 4. */
export function spreadSentence(monthlyBudgetCents: number, dailyCents = 500): string {
  const d = spreadDaysPerWeek(monthlyBudgetCents, dailyCents);
  if (d >= 7) return "Your ad shows most days for most of the month.";
  if (d <= 1) return "Your ad shows about 1 day a week for most of the month.";
  return `Your ad shows about ${d} days a week for most of the month.`;
}

/** The one allowed per-day statement: Google's minimum, not a daily price. */
export function googleMinimumSentence(budgetCents: number, dailyCents = 500): string {
  const days = showingDays(budgetCents, dailyCents);
  const money = `$${(budgetCents / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  return `Google spends at least $5 a day on this kind of ad (some days a little more), so ${money} covers about ${days} day${days === 1 ? "" : "s"} of showing.`;
}

export const ADD_MORE_LINE = "Want it shown more? Add to your ad budget anytime.";

// Daily-budget bounds, mirrored from the API (minDailyBudgetMinorFor in
// api/src/lib/pricing, dailyBudgetCents in api/src/routes/campaigns.ts) so
// forms say so up front instead of the server refusing after submit.
//
// USD $5/day is Google's per-day minimum for a Demand Gen campaign. It was
// lowered to $1 on 2026-11-10 and Google refused those budgets at launch
// (BUDGET_BELOW_PER_DAY_MINIMUM, found by a dry run on 2026-11-19).
const MIN_BY_CURRENCY: Record<string, number> = { USD: 500, INR: 10_000 };

export const MAX_DAILY_BUDGET_CENTS = 50_000;

export function minDailyBudgetCents(currency: string): number {
  return MIN_BY_CURRENCY[currency] ?? 100;
}

/** The launch card's message for `budget_below_minimum`. */
export const BUDGET_BELOW_MINIMUM_MESSAGE =
  "Google needs at least $5 a day for this kind of ad. Raise your daily budget to launch.";

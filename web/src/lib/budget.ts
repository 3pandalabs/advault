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

// How long an ad runs, mirrored from api/src/lib/pricing (RUN_DAYS,
// adSpendTotalMinor). 7 or 14 days; null = always on (no end date).
export type RunDays = 7 | 14 | null;

export const RUN_CHOICES: { value: RunDays; label: string }[] = [
  { value: 7, label: "1 week" },
  { value: 14, label: "2 weeks" },
  { value: null, label: "Always on" },
];

/** Average days in a month, for the always-on estimate. */
export const DAYS_PER_MONTH = 30.4;

/** Total ad spend: daily x 7 / x 14, or about one month (x 30.4) for always on. */
export function adSpendTotalCents(dailyCents: number, runDays: RunDays): number {
  return Math.round(dailyCents * (runDays ?? DAYS_PER_MONTH));
}

/** "$35" or "$35.50". */
export function formatUsdCents(cents: number): string {
  const d = cents / 100;
  return `$${Number.isInteger(d) ? d.toLocaleString("en-US") : d.toFixed(2)}`;
}

/** "Runs 1 week (ends Nov 24)" / "Always on", for the campaign page. */
export function runLengthLabel(runDays: number | null | undefined, endsOn?: string | null): string {
  if (runDays !== 7 && runDays !== 14) return "Always on";
  const label = runDays === 7 ? "1 week" : "2 weeks";
  if (!endsOn) return `Runs ${label}`;
  const end = new Date(`${endsOn}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  return `Runs ${label} (ends ${end})`;
}

// Top-up-first model (2026-11-19), mirrored from api/src/lib/wallet/runway.ts.
// The customer adds to a prepaid ad budget; the ad runs always on at its daily
// budget until the budget runs out.
export const TOPUP_PRESETS_CENTS: Record<string, number[]> = {
  USD: [3_500, 5_000, 10_000],
  INR: [200_000, 500_000, 1_000_000],
};

export function topupPresets(currency: string): number[] {
  return TOPUP_PRESETS_CENTS[currency] ?? TOPUP_PRESETS_CENTS.USD;
}

/** The smallest top-up: the first preset ($35). */
export function minTopupCents(currency: string): number {
  return topupPresets(currency)[0];
}

/** Whole days a budget lasts at a daily rate: floor, at least 1 while money is left. */
export function daysOfBudget(balanceCents: number, dailyCents: number): number {
  if (balanceCents <= 0 || dailyCents <= 0) return 0;
  return Math.max(1, Math.floor(balanceCents / dailyCents));
}

/** "about 10 days" / "about 1 day". */
export function aboutDays(days: number): string {
  return `about ${days} day${days === 1 ? "" : "s"}`;
}

/** "Your $50 lasts about 10 days at $5 a day." */
export function lastsSentence(amountCents: number, dailyCents: number, currency: string, prefix = "Your"): string {
  const money = (c: number) =>
    new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: c % 100 === 0 ? 0 : 2 }).format(c / 100);
  return `${prefix} ${money(amountCents)} lasts ${aboutDays(daysOfBudget(amountCents, dailyCents))} at ${money(dailyCents)} a day.`;
}

/** sessionStorage key for the top-up amount picked in the wizard (nothing is charged there). */
export const wizardTopupKey = (campaignId: string) => `advault:topup:${campaignId}`;

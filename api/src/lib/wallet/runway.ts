// How long an ad budget lasts, and when it counts as "running low"
// (2026-11-19, top-up-first model). Pure: no db, no fetch. Mirrored for the
// browser in web/src/lib/budget.ts (daysOfBudget, TOPUP_PRESETS_CENTS).
//
// The customer tops up a prepaid balance and the campaign runs ALWAYS ON at
// its daily budget until the balance runs out (render/spendSync.ts pauses it,
// a top-up resumes it: lib/billing/resume.ts). These helpers turn that into
// the plain sentences the dashboard shows: "Your $50 lasts about 10 days at
// $5 a day", "about 2 days left".

import type { Currency } from "../pricing/index.js";

/** Top-up presets (minor units). The first is also the smallest custom amount. */
export const TOPUP_PRESETS_MINOR: Record<Currency, number[]> = {
  USD: [3_500, 5_000, 10_000],
  INR: [200_000, 500_000, 1_000_000],
};

export function minTopupMinor(currency: Currency): number {
  return TOPUP_PRESETS_MINOR[currency]?.[0] ?? TOPUP_PRESETS_MINOR.USD[0]!;
}

/**
 * Whole days a balance lasts at a daily budget: floor(balance / daily), at
 * least 1 while there is any money left (a $3 balance on a $5/day ad still
 * runs today). 0 when the balance is gone or there is no daily budget.
 */
export function daysOfBudget(balanceMinor: number, dailyMinor: number): number {
  if (balanceMinor <= 0 || dailyMinor <= 0) return 0;
  return Math.max(1, Math.floor(balanceMinor / dailyMinor));
}

/** "Running low" floor besides two days of budget: $10 / ₹1,000. */
const LOW_FLOOR_MINOR: Record<Currency, number> = { USD: 1_000, INR: 100_000 };

/** Days of budget under which the balance counts as low. */
export const LOW_BALANCE_DAYS = 2;

/** Low below max(2 days of the daily budget, $10). */
export function lowBalanceThresholdMinor(dailyMinor: number, currency: Currency): number {
  return Math.max(dailyMinor * LOW_BALANCE_DAYS, LOW_FLOOR_MINOR[currency] ?? LOW_FLOOR_MINOR.USD);
}

/** Money left, but less than the low threshold. A zero balance is "empty", not low. */
export function isLowBalance(balanceMinor: number, dailyMinor: number, currency: Currency): boolean {
  if (dailyMinor <= 0 || balanceMinor <= 0) return false;
  return balanceMinor < lowBalanceThresholdMinor(dailyMinor, currency);
}

/**
 * One alert per low-balance episode. `alertedAt` is campaigns.low_balance_alerted_at:
 * set when we alerted, cleared once the balance is healthy again (a top-up),
 * so the next dip alerts again.
 *   alert — low now and not yet alerted this episode: send, then set alertedAt
 *   clear — healthy again with alertedAt still set: clear it
 *   none  — nothing to do
 */
export function lowBalanceEpisode(args: { low: boolean; alertedAt: Date | null }): "alert" | "clear" | "none" {
  if (args.low) return args.alertedAt ? "none" : "alert";
  return args.alertedAt ? "clear" : "none";
}

export type BudgetState =
  /** No live (or paused-for-funds) platform-funded campaign: nothing to warn about. */
  | "idle"
  | "ok"
  /** Live, and under the low threshold. */
  | "low"
  /** A campaign is paused (or about to be) because the balance ran out. */
  | "empty";

/**
 * The account-wide budget picture for the dashboard banner. The wallet is
 * shared by all of the advertiser's campaigns, so days left uses the SUM of
 * the live campaigns' daily budgets.
 */
export function budgetState(args: {
  balanceMinor: number;
  currency: Currency;
  /** Sum of daily budgets of live, platform-funded campaigns. */
  liveDailyMinor: number;
  /** Platform-funded campaigns currently paused because the money ran out. */
  pausedForFunds: number;
}): { state: BudgetState; daysLeft: number | null } {
  const { balanceMinor, currency, liveDailyMinor, pausedForFunds } = args;
  if (liveDailyMinor <= 0) {
    return pausedForFunds > 0 ? { state: "empty", daysLeft: 0 } : { state: "idle", daysLeft: null };
  }
  const daysLeft = daysOfBudget(balanceMinor, liveDailyMinor);
  if (balanceMinor <= 0 || pausedForFunds > 0) return { state: "empty", daysLeft };
  if (isLowBalance(balanceMinor, liveDailyMinor, currency)) return { state: "low", daysLeft };
  return { state: "ok", daysLeft };
}

/**
 * Which paused-for-funds campaigns a balance can restart, in the order given.
 * Each must leave the SAME cover the launch guard demands (`fundedDays` of the
 * running total of daily budgets, MIN_FUNDED_DAYS in lib/wallet), so a top-up
 * that would only buy a few hours does not flap a campaign on and off. A
 * campaign whose run already ended (`endsOn` before today, UTC) stays paused:
 * Google has stopped it for good.
 */
export function campaignsToResume<T extends { dailyMinor: number; endsOn: string | null }>(args: {
  balanceMinor: number;
  candidates: T[];
  fundedDays: number;
  todayIso: string;
}): T[] {
  const out: T[] = [];
  let committed = 0;
  for (const c of args.candidates) {
    if (c.endsOn && c.endsOn < args.todayIso) continue;
    if (c.dailyMinor <= 0) continue;
    if (args.balanceMinor < (committed + c.dailyMinor) * args.fundedDays) continue;
    committed += c.dailyMinor;
    out.push(c);
  }
  return out;
}

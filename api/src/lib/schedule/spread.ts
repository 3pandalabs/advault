// "$55 a month" (owner decision 2026-11-19, option C): spread the month's ad
// budget across the month instead of spending it in the first week.
//
// $35 at Google's $5/day Demand Gen minimum buys about 7 days of showing. Run
// always-on, that is the first 7 days and then nothing for three weeks. So by
// default the campaign gets an ad schedule (lib/schedule/policy.ts, PR #137)
// of a few whole days a week, the same days every week, all month: "Your ad
// shows on about 2 days a week, all month." More budget means more days.
//
// Pure, tested (spread.test.ts). The arithmetic is mirrored for the browser
// in web/src/lib/spread.ts; keep the two in step.
//
// Overspend: Google may spend up to 2x the daily budget on any day it serves,
// and with a schedule it tends to (its monthly cap is 30.4 x daily, met on
// fewer days). The wallet still cannot be overdrawn: render/spendSync.ts
// pauses a scheduled campaign once the balance is under OVERSPEND_FACTOR days
// of budget (`pauseForHeadroom`), so a serving day can never cost more than
// is left, and the money it leaves rolls over to the next recharge/top-up.

import type { CategoryKey } from "../categories/key.js";
import { DAYS, normalizeAdSchedule, type AdSchedule, type Day } from "./policy.js";

/** Average weeks in a month (30.4 / 7). */
export const SPREAD_WEEKS_PER_MONTH = 4.35;

/** Google may spend up to this many times the daily budget on a day it serves. */
export const OVERSPEND_FACTOR = 2;

/**
 * Days a week the ad shows when this month's budget is spread over the month
 * at the daily budget: round(budget / daily / 4.35), 1..7. $35 -> 2, $50 -> 2,
 * $70 -> 3, $100 -> 5, $150+ -> 7 (every day). 0 when there is no budget.
 */
export function spreadDaysPerWeek(monthlyBudgetMinor: number, dailyMinor: number): number {
  if (monthlyBudgetMinor <= 0 || dailyMinor <= 0) return 0;
  return Math.min(7, Math.max(1, Math.round(monthlyBudgetMinor / dailyMinor / SPREAD_WEEKS_PER_MONTH)));
}

/** Days of showing a budget buys at the daily budget: $35 at $5 -> 7. */
export function showingDays(budgetMinor: number, dailyMinor: number): number {
  if (budgetMinor <= 0 || dailyMinor <= 0) return 0;
  return Math.max(1, Math.floor(budgetMinor / dailyMinor));
}

// Which days first, per category. The first N in the list are used, then put
// in week order. Default: as evenly spaced as N allows (2 -> Wed + Sat,
// 3 -> Mon, Wed, Sat). Restaurants: the nights people go out. Landscaping:
// weekends, when owners look at their yards. Real estate: open-house weekends.
// Dentistry: weekdays, when the office answers the phone. The owner can
// change the days on the campaign page ("When it shows").
const DEFAULT_ORDER: readonly Day[] = ["sat", "wed", "mon", "fri", "tue", "thu", "sun"];
export const SPREAD_DAY_ORDER: Partial<Record<CategoryKey, readonly Day[]>> = {
  restaurant: ["fri", "sat", "thu", "sun", "wed", "tue", "mon"],
  landscaping: ["sat", "sun", "thu", "tue", "fri", "wed", "mon"],
  realEstate: ["sat", "sun", "thu", "wed", "fri", "tue", "mon"],
  dentistry: ["tue", "thu", "mon", "wed", "fri", "sat", "sun"],
};

/** The N days for a category, in week order. */
export function spreadDays(daysPerWeek: number, key: CategoryKey | null): Day[] {
  const n = Math.min(7, Math.max(0, Math.floor(daysPerWeek)));
  const order = (key && SPREAD_DAY_ORDER[key]) || DEFAULT_ORDER;
  const pick = new Set(order.slice(0, n));
  return DAYS.filter((d) => pick.has(d));
}

/**
 * The spread schedule for a month's budget: whole days (0-24) on the chosen
 * days. null = every day, all day (the budget covers the whole month, or
 * there is no budget to plan with and the old always-on behaviour applies).
 */
export function spreadSchedule(args: {
  monthlyBudgetMinor: number;
  dailyMinor: number;
  categoryKey: CategoryKey | null;
}): AdSchedule | null {
  const n = spreadDaysPerWeek(args.monthlyBudgetMinor, args.dailyMinor);
  if (n === 0 || n >= 7) return null;
  return normalizeAdSchedule({ days: spreadDays(n, args.categoryKey), startHour: 0, endHour: 24 });
}

/** Same days? (Whether a re-spread needs a Google edit at all.) */
export function sameSchedule(a: AdSchedule | null, b: AdSchedule | null): boolean {
  return JSON.stringify(normalizeAdSchedule(a)) === JSON.stringify(normalizeAdSchedule(b));
}

/**
 * Should spendSync pause a campaign for funds now? Always at an empty wallet
 * (the old rule). A SCHEDULED campaign also pauses once the balance is under
 * OVERSPEND_FACTOR x the daily budget of every live campaign sharing the
 * wallet: Google may spend 2x on a serving day, and the next one may be hours
 * away, before our hourly sync sees the spend.
 */
export function pauseForFunds(args: { balanceMinor: number; scheduled: boolean; liveDailyMinor: number }): boolean {
  if (args.balanceMinor <= 0) return true;
  return args.scheduled && args.balanceMinor < OVERSPEND_FACTOR * args.liveDailyMinor;
}

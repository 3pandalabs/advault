import { describe, expect, it } from "vitest";
import { adScheduleCriteria } from "./policy.js";
import {
  OVERSPEND_FACTOR,
  pauseForFunds,
  sameSchedule,
  showingDays,
  spreadDays,
  spreadDaysPerWeek,
  spreadSchedule,
} from "./spread.js";

describe("spreading the month's budget", () => {
  it("$35 at Google's $5 minimum is about 7 days of showing, about 2 days a week", () => {
    expect(showingDays(3_500, 500)).toBe(7);
    expect(spreadDaysPerWeek(3_500, 500)).toBe(2);
  });

  it("more budget means more days, up to every day", () => {
    const days = [3_500, 5_000, 7_000, 10_000, 13_000, 15_000, 50_000].map((b) => spreadDaysPerWeek(b, 500));
    expect(days).toEqual([2, 2, 3, 5, 6, 7, 7]);
    for (let i = 1; i < days.length; i++) expect(days[i]).toBeGreaterThanOrEqual(days[i - 1]!);
    // A higher daily budget spends the same money on fewer days.
    expect(spreadDaysPerWeek(3_500, 1_000)).toBe(1);
  });

  it("no budget, no plan to spread", () => {
    expect(spreadDaysPerWeek(0, 500)).toBe(0);
    expect(spreadDaysPerWeek(3_500, 0)).toBe(0);
    expect(spreadSchedule({ monthlyBudgetMinor: 0, dailyMinor: 500, categoryKey: null })).toBeNull();
  });

  it("spaces the days through the week by default", () => {
    expect(spreadDays(1, null)).toEqual(["sat"]);
    expect(spreadDays(2, null)).toEqual(["wed", "sat"]);
    expect(spreadDays(3, null)).toEqual(["mon", "wed", "sat"]);
    expect(spreadDays(4, "plumbing")).toEqual(["mon", "wed", "fri", "sat"]);
  });

  it("picks the best days per category", () => {
    expect(spreadDays(2, "restaurant")).toEqual(["fri", "sat"]);
    expect(spreadDays(2, "landscaping")).toEqual(["sat", "sun"]);
    expect(spreadDays(2, "realEstate")).toEqual(["sat", "sun"]);
    expect(spreadDays(2, "dentistry")).toEqual(["tue", "thu"]);
  });

  it("is whole days on those days, every day = no schedule at all", () => {
    const s = spreadSchedule({ monthlyBudgetMinor: 3_500, dailyMinor: 500, categoryKey: "restaurant" });
    expect(s).toEqual({ days: ["fri", "sat"], startHour: 0, endHour: 24 });
    expect(adScheduleCriteria(s).map((c) => c.dayOfWeek)).toEqual(["FRIDAY", "SATURDAY"]);
    expect(spreadSchedule({ monthlyBudgetMinor: 20_000, dailyMinor: 500, categoryKey: "restaurant" })).toBeNull();
  });

  it("knows when a re-spread changes nothing", () => {
    const a = spreadSchedule({ monthlyBudgetMinor: 3_500, dailyMinor: 500, categoryKey: null });
    const b = spreadSchedule({ monthlyBudgetMinor: 5_000, dailyMinor: 500, categoryKey: null });
    const c = spreadSchedule({ monthlyBudgetMinor: 7_000, dailyMinor: 500, categoryKey: null });
    expect(sameSchedule(a, b)).toBe(true);
    expect(sameSchedule(a, c)).toBe(false);
    expect(sameSchedule(null, null)).toBe(true);
  });
});

describe("the wallet can't be overspent by Google's 2x days", () => {
  it("an empty wallet always pauses", () => {
    expect(pauseForFunds({ balanceMinor: 0, scheduled: false, liveDailyMinor: 500 })).toBe(true);
    expect(pauseForFunds({ balanceMinor: -10, scheduled: true, liveDailyMinor: 500 })).toBe(true);
  });

  it("a scheduled ad pauses while it can't cover a 2x day; an always-on ad keeps the old rule", () => {
    expect(OVERSPEND_FACTOR).toBe(2);
    expect(pauseForFunds({ balanceMinor: 999, scheduled: true, liveDailyMinor: 500 })).toBe(true);
    expect(pauseForFunds({ balanceMinor: 1_000, scheduled: true, liveDailyMinor: 500 })).toBe(false);
    expect(pauseForFunds({ balanceMinor: 999, scheduled: false, liveDailyMinor: 500 })).toBe(false);
    // Two campaigns share the wallet: the headroom is for both.
    expect(pauseForFunds({ balanceMinor: 1_500, scheduled: true, liveDailyMinor: 1_000 })).toBe(true);
  });

  it("$35 over spread days: worst case every serving day costs 2x and the wallet never goes below zero", () => {
    let balance = 3_500;
    let days = 0;
    while (!pauseForFunds({ balanceMinor: balance, scheduled: true, liveDailyMinor: 500 })) {
      balance -= OVERSPEND_FACTOR * 500; // Google's maximum on a day
      days += 1;
      expect(balance).toBeGreaterThanOrEqual(0);
    }
    expect(days).toBe(3);
    // At $5 a day exactly it shows 6 days and $5 rolls over to next month.
    balance = 3_500;
    days = 0;
    while (!pauseForFunds({ balanceMinor: balance, scheduled: true, liveDailyMinor: 500 })) {
      balance -= 500;
      days += 1;
    }
    expect([days, balance]).toEqual([6, 500]);
  });
});

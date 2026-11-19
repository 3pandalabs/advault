import { describe, expect, it } from "vitest";
import {
  budgetState,
  campaignsToResume,
  daysOfBudget,
  isLowBalance,
  lowBalanceEpisode,
  lowBalanceThresholdMinor,
  minTopupMinor,
  TOPUP_PRESETS_MINOR,
} from "./runway.js";

describe("daysOfBudget", () => {
  it("floors balance / daily", () => {
    expect(daysOfBudget(5_000, 500)).toBe(10);
    expect(daysOfBudget(3_500, 500)).toBe(7);
    expect(daysOfBudget(5_400, 500)).toBe(10);
  });
  it("is at least 1 while money is left", () => {
    expect(daysOfBudget(300, 500)).toBe(1);
    expect(daysOfBudget(1, 500)).toBe(1);
  });
  it("is 0 with no money or no budget", () => {
    expect(daysOfBudget(0, 500)).toBe(0);
    expect(daysOfBudget(-200, 500)).toBe(0);
    expect(daysOfBudget(5_000, 0)).toBe(0);
  });
});

describe("top-up presets", () => {
  it("are $35 / $50 / $100 and the smallest is the minimum", () => {
    expect(TOPUP_PRESETS_MINOR.USD).toEqual([3_500, 5_000, 10_000]);
    expect(minTopupMinor("USD")).toBe(3_500);
  });
});

describe("low balance", () => {
  it("threshold is the larger of 2 days and $10", () => {
    expect(lowBalanceThresholdMinor(500, "USD")).toBe(1_000);
    expect(lowBalanceThresholdMinor(800, "USD")).toBe(1_600);
    expect(lowBalanceThresholdMinor(100, "USD")).toBe(1_000);
  });
  it("is low under the threshold but not at zero (that is empty)", () => {
    expect(isLowBalance(999, 500, "USD")).toBe(true);
    expect(isLowBalance(1_000, 500, "USD")).toBe(false);
    expect(isLowBalance(0, 500, "USD")).toBe(false);
    expect(isLowBalance(1_500, 800, "USD")).toBe(true);
    expect(isLowBalance(500, 0, "USD")).toBe(false);
  });
  it("alerts once per episode and re-arms after recovery", () => {
    const t = new Date();
    expect(lowBalanceEpisode({ low: true, alertedAt: null })).toBe("alert");
    expect(lowBalanceEpisode({ low: true, alertedAt: t })).toBe("none");
    expect(lowBalanceEpisode({ low: false, alertedAt: t })).toBe("clear");
    expect(lowBalanceEpisode({ low: false, alertedAt: null })).toBe("none");
  });
});

describe("budgetState", () => {
  it("idle with nothing running", () => {
    expect(budgetState({ balanceMinor: 5_000, currency: "USD", liveDailyMinor: 0, pausedForFunds: 0 })).toEqual({
      state: "idle",
      daysLeft: null,
    });
  });
  it("ok / low / empty for a live campaign", () => {
    expect(budgetState({ balanceMinor: 5_000, currency: "USD", liveDailyMinor: 500, pausedForFunds: 0 })).toEqual({
      state: "ok",
      daysLeft: 10,
    });
    expect(budgetState({ balanceMinor: 900, currency: "USD", liveDailyMinor: 500, pausedForFunds: 0 })).toEqual({
      state: "low",
      daysLeft: 1,
    });
    expect(budgetState({ balanceMinor: 0, currency: "USD", liveDailyMinor: 500, pausedForFunds: 0 }).state).toBe("empty");
  });
  it("empty when a campaign is paused for funds", () => {
    expect(budgetState({ balanceMinor: 0, currency: "USD", liveDailyMinor: 0, pausedForFunds: 1 })).toEqual({
      state: "empty",
      daysLeft: 0,
    });
  });
  it("sums the shared wallet across live campaigns", () => {
    expect(budgetState({ balanceMinor: 5_000, currency: "USD", liveDailyMinor: 1_000, pausedForFunds: 0 }).daysLeft).toBe(5);
  });
});

describe("campaignsToResume", () => {
  const c = (id: string, dailyMinor: number, endsOn: string | null = null) => ({ id, dailyMinor, endsOn });
  it("needs fundedDays of cover for the running total", () => {
    const out = campaignsToResume({
      balanceMinor: 3_500,
      candidates: [c("a", 500), c("b", 1_000)],
      fundedDays: 3,
      todayIso: "2026-11-19",
    });
    expect(out.map((x) => x.id)).toEqual(["a"]);
  });
  it("refuses a top-up too small to cover the guard", () => {
    expect(campaignsToResume({ balanceMinor: 1_000, candidates: [c("a", 500)], fundedDays: 3, todayIso: "2026-11-19" })).toEqual([]);
  });
  it("skips a campaign whose run already ended", () => {
    const out = campaignsToResume({
      balanceMinor: 10_000,
      candidates: [c("a", 500, "2026-11-18"), c("b", 500, "2026-11-19")],
      fundedDays: 3,
      todayIso: "2026-11-19",
    });
    expect(out.map((x) => x.id)).toEqual(["b"]);
  });
});

describe("top-up estimate", () => {
  it("clicks are amount / $2.00 .. amount / $0.50, rounded", async () => {
    const { estimateClicks, roundCount } = await import("./runway.js");
    expect(estimateClicks(5_000, "USD")).toEqual({ low: 25, high: 100 });
    expect(estimateClicks(3_500, "USD")).toEqual({ low: 18, high: 70 });
    expect(estimateClicks(10_000, "USD")).toEqual({ low: 50, high: 200 });
    expect(estimateClicks(0, "USD")).toEqual({ low: 0, high: 0 });
    expect(roundCount(123)).toBe(125);
    expect(roundCount(1_234)).toBe(1_230);
  });
  it("$50 at $5 a day: 10 days, times shown from estimateReach, 25-100 clicks", async () => {
    const { topupEstimate } = await import("./topupEstimate.js");
    expect(topupEstimate(5_000, 500, "USD")).toEqual({
      days: 10,
      shownLow: 8_500,
      shownHigh: 16_500,
      clicks: { low: 25, high: 100 },
    });
    // The FAQ's $35 figure.
    expect(topupEstimate(3_500, 500, "USD")).toMatchObject({ days: 7, shownLow: 6_000, shownHigh: 11_500 });
  });
});

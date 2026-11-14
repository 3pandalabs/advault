import { describe, expect, it } from "vitest";
import { assess, dailyBurn, shouldAlert } from "./balancePolicy.js";

const now = new Date("2026-11-14T12:00:00Z");
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);

describe("dailyBurn", () => {
  it("is null without enough history", () => {
    expect(dailyBurn([{ balance: 20, at: hoursAgo(1) }], now)).toBeNull();
    expect(dailyBurn([{ balance: 20, at: hoursAgo(2) }, { balance: 19, at: hoursAgo(1) }], now)).toBeNull();
  });

  it("averages drops per day and ignores top-ups", () => {
    const r = [
      { balance: 30, at: hoursAgo(96) },
      { balance: 26, at: hoursAgo(72) }, // -4
      { balance: 50, at: hoursAgo(48) }, // top-up
      { balance: 46, at: hoursAgo(24) }, // -4
      { balance: 42, at: hoursAgo(0) }, // -4
    ];
    expect(dailyBurn(r, now)).toBeCloseTo(3); // 12 over 4 days
  });

  it("does not extrapolate one busy hour into a huge daily rate", () => {
    const r = [
      { balance: 20, at: hoursAgo(8) },
      { balance: 15, at: hoursAgo(0) },
    ];
    expect(dailyBurn(r, now)).toBe(5);
  });
});

describe("assess", () => {
  it("uses the floor when spend is low", () => {
    expect(assess(4, 0.1)).toMatchObject({ level: "low", threshold: 5 });
    expect(assess(20, null)).toMatchObject({ level: "ok", threshold: 5, runwayDays: null });
  });
  it("scales the threshold with spend", () => {
    const a = assess(30, 5); // threshold 35, critical 10
    expect(a).toMatchObject({ level: "low", threshold: 35, critical: 10, runwayDays: 6 });
    expect(assess(8, 5).level).toBe("critical");
    expect(assess(40, 5).level).toBe("ok");
  });
});

describe("shouldAlert", () => {
  it("alerts when it gets worse, repeats daily, reports recovery once", () => {
    expect(shouldAlert("low", null, now)).toBe("worse");
    expect(shouldAlert("critical", { level: "low", lastAlertAt: hoursAgo(1) }, now)).toBe("worse");
    expect(shouldAlert("low", { level: "low", lastAlertAt: hoursAgo(2) }, now)).toBeNull();
    expect(shouldAlert("low", { level: "low", lastAlertAt: hoursAgo(25) }, now)).toBe("repeat");
    expect(shouldAlert("ok", { level: "low", lastAlertAt: hoursAgo(3) }, now)).toBe("recovered");
    expect(shouldAlert("ok", { level: "ok", lastAlertAt: null }, now)).toBeNull();
  });
});

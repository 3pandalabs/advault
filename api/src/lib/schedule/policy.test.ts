import { describe, expect, it } from "vitest";
import { adScheduleCriteria, adScheduleSchema, normalizeAdSchedule, windowsOverlap } from "./policy.js";

describe("adScheduleSchema", () => {
  it("accepts days + a window, refuses bad windows and days", () => {
    expect(adScheduleSchema.safeParse({ days: ["mon"], startHour: 9, endHour: 17 }).success).toBe(true);
    expect(adScheduleSchema.safeParse({ days: ["mon"], startHour: 17, endHour: 9 }).success).toBe(false);
    expect(adScheduleSchema.safeParse({ days: ["mon"], startHour: 9, endHour: 9 }).success).toBe(false);
    expect(adScheduleSchema.safeParse({ days: [], startHour: 9, endHour: 17 }).success).toBe(false);
    expect(adScheduleSchema.safeParse({ days: ["mon", "mon"], startHour: 9, endHour: 17 }).success).toBe(false);
    expect(adScheduleSchema.safeParse({ days: ["monday"], startHour: 9, endHour: 17 }).success).toBe(false);
    expect(adScheduleSchema.safeParse({ days: ["mon"], startHour: 0, endHour: 25 }).success).toBe(false);
    expect(adScheduleSchema.safeParse({ days: ["mon"], startHour: 9, endHour: 17, tz: "x" }).success).toBe(false);
  });
});

describe("normalizeAdSchedule", () => {
  it("sorts days into week order", () => {
    expect(normalizeAdSchedule({ days: ["sun", "mon"], startHour: 8, endHour: 20 })).toEqual({
      days: ["mon", "sun"],
      startHour: 8,
      endHour: 20,
    });
  });

  it("every day, all day is null (no criteria)", () => {
    expect(normalizeAdSchedule({ days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], startHour: 0, endHour: 24 })).toBeNull();
    expect(normalizeAdSchedule(null)).toBeNull();
    expect(adScheduleCriteria(null)).toEqual([]);
  });

  it("every day with a window is kept", () => {
    expect(normalizeAdSchedule({ days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], startHour: 9, endHour: 21 })).not.toBeNull();
  });
});

describe("adScheduleCriteria", () => {
  it("one Google AdScheduleInfo per day, whole hours", () => {
    expect(adScheduleCriteria({ days: ["sat", "fri"], startHour: 0, endHour: 24 })).toEqual([
      { dayOfWeek: "FRIDAY", startHour: 0, startMinute: "ZERO", endHour: 24, endMinute: "ZERO" },
      { dayOfWeek: "SATURDAY", startHour: 0, startMinute: "ZERO", endHour: 24, endMinute: "ZERO" },
    ]);
  });
});

describe("extra windows (2026-11-20)", () => {
  const ALL = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as ("mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun")[];
  const lunchDinner = { days: ALL, startHour: 11, endHour: 14, extraWindows: [{ days: ALL, startHour: 17, endHour: 21 }] };

  it("accepts up to two more windows, refuses overlaps and bad windows", () => {
    expect(adScheduleSchema.safeParse(lunchDinner).success).toBe(true);
    expect(adScheduleSchema.safeParse({ ...lunchDinner, extraWindows: [{ days: ["mon"], startHour: 13, endHour: 15 }] }).success).toBe(false);
    // Same hours on different days do not overlap.
    expect(
      adScheduleSchema.safeParse({ days: ["mon"], startHour: 9, endHour: 17, extraWindows: [{ days: ["sat"], startHour: 9, endHour: 17 }] }).success,
    ).toBe(true);
    expect(adScheduleSchema.safeParse({ ...lunchDinner, extraWindows: [{ days: ["mon"], startHour: 15, endHour: 15 }] }).success).toBe(false);
    const three = [
      { days: ["mon"], startHour: 1, endHour: 2 },
      { days: ["mon"], startHour: 3, endHour: 4 },
      { days: ["mon"], startHour: 5, endHour: 6 },
    ];
    expect(adScheduleSchema.safeParse({ days: ["mon"], startHour: 9, endHour: 10, extraWindows: three }).success).toBe(false);
  });

  it("windowsOverlap: touching windows are fine", () => {
    expect(windowsOverlap([{ days: ["mon"], startHour: 9, endHour: 12 }, { days: ["mon"], startHour: 12, endHour: 14 }])).toBe(false);
    expect(windowsOverlap([{ days: ["mon"], startHour: 9, endHour: 12 }, { days: ["mon", "tue"], startHour: 11, endHour: 14 }])).toBe(true);
  });

  it("every day all day plus a window is not 'always'; empty extras are dropped", () => {
    expect(
      normalizeAdSchedule({ days: ["sun", "sat"], startHour: 0, endHour: 24, extraWindows: [{ days: ["fri", "mon"], startHour: 17, endHour: 24 }] }),
    ).toEqual({ days: ["sat", "sun"], startHour: 0, endHour: 24, extraWindows: [{ days: ["mon", "fri"], startHour: 17, endHour: 24 }] });
    expect(normalizeAdSchedule({ days: ["mon"], startHour: 1, endHour: 2, extraWindows: [] })).toEqual({ days: ["mon"], startHour: 1, endHour: 2 });
  });

  it("criteria: every window per day, week order, earliest first", () => {
    const c = adScheduleCriteria({ days: ["sat", "sun"], startHour: 0, endHour: 24, extraWindows: [{ days: ["mon"], startHour: 17, endHour: 24 }] });
    expect(c.map((x) => `${x.dayOfWeek} ${x.startHour}-${x.endHour}`)).toEqual(["MONDAY 17-24", "SATURDAY 0-24", "SUNDAY 0-24"]);
    const ld = adScheduleCriteria(lunchDinner);
    expect(ld).toHaveLength(14);
    expect(ld.filter((x) => x.dayOfWeek === "MONDAY").map((x) => x.startHour)).toEqual([11, 17]);
  });
});

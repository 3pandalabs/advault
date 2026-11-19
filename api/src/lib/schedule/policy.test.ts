import { describe, expect, it } from "vitest";
import { adScheduleCriteria, adScheduleSchema, normalizeAdSchedule } from "./policy.js";

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

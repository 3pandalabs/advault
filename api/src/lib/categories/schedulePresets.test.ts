import { describe, expect, it } from "vitest";
import { adScheduleSchema, adScheduleCriteria, normalizeAdSchedule } from "../schedule/policy.js";
import { CATEGORY_KEYS } from "./key.js";
import { SCHEDULE_PRESETS, schedulePresets } from "./schedulePresets.js";

describe("schedule presets", () => {
  it("every preset schedule is valid and survives normalising", () => {
    for (const k of CATEGORY_KEYS) {
      for (const p of schedulePresets(k)) {
        if (p.schedule === null) continue;
        expect(adScheduleSchema.safeParse(p.schedule).success, p.id).toBe(true);
        expect(normalizeAdSchedule(p.schedule), p.id).toEqual(p.schedule);
      }
    }
  });

  it("trades: 24/7 and evenings + weekends", () => {
    for (const k of ["plumbing", "hvac", "electrical"] as const) {
      expect(schedulePresets(k).map((p) => p.id)).toEqual(["always", "evenings-weekends"]);
    }
    const ew = SCHEDULE_PRESETS.plumbing![1]!.schedule;
    const c = adScheduleCriteria(ew).map((x) => `${x.dayOfWeek} ${x.startHour}-${x.endHour}`);
    expect(c).toEqual([
      "MONDAY 17-24",
      "TUESDAY 17-24",
      "WEDNESDAY 17-24",
      "THURSDAY 17-24",
      "FRIDAY 17-24",
      "SATURDAY 0-24",
      "SUNDAY 0-24",
    ]);
  });

  it("restaurant: a lunch window and a dinner window every day", () => {
    const c = adScheduleCriteria(SCHEDULE_PRESETS.restaurant![0]!.schedule);
    expect(c).toHaveLength(14);
    expect(c.filter((x) => x.dayOfWeek === "FRIDAY").map((x) => [x.startHour, x.endHour])).toEqual([
      [11, 14],
      [17, 21],
    ]);
  });

  it("none for the other categories or none", () => {
    expect(schedulePresets("dentistry")).toEqual([]);
    expect(schedulePresets(null)).toEqual([]);
  });
});

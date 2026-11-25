// Browser mirror of api/src/lib/categories/schedulePresets.ts. The API is the real
// boundary; the block between the <shared> markers is kept word for word
// by api/src/lib/categories/mirror.test.ts. Edit the API copy, then this.

import type { AdSchedule } from "@/lib/schedule";
import type { CategoryKey } from "./key";

// <shared>
export type SchedulePreset = {
  id: string;
  label: string;
  /** One plain sentence under the button. */
  hint: string;
  /** null = every day, all day. */
  schedule: AdSchedule | null;
};

const WEEKDAYS: AdSchedule["days"] = ["mon", "tue", "wed", "thu", "fri"];
const EVERY_DAY: AdSchedule["days"] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

const TRADE_PRESETS: readonly SchedulePreset[] = [
  {
    id: "always",
    label: "24/7 for emergencies",
    hint: "Day and night, every day, for burst pipes and breakdowns. Best if you answer the phone at night.",
    schedule: null,
  },
  {
    id: "evenings-weekends",
    label: "Evenings and weekends",
    hint: "Weekdays 5 pm to midnight and all weekend, when people are home and other shops are closed.",
    schedule: {
      days: WEEKDAYS,
      startHour: 17,
      endHour: 24,
      extraWindows: [{ days: ["sat", "sun"], startHour: 0, endHour: 24 }],
    },
  },
];

export const SCHEDULE_PRESETS: Partial<Record<CategoryKey, readonly SchedulePreset[]>> = {
  plumbing: TRADE_PRESETS,
  hvac: TRADE_PRESETS,
  electrical: TRADE_PRESETS,
  carWash: [
    {
      id: "daytime",
      label: "Daytime, every day",
      hint: "Every day 8 am to 6 pm, when people can drive over now.",
      schedule: { days: EVERY_DAY, startHour: 8, endHour: 18 },
    },
    {
      id: "weekend",
      label: "Thursday to Sunday",
      hint: "Thursday to Sunday 8 am to 6 pm, around the weekend.",
      schedule: { days: ["thu", "fri", "sat", "sun"], startHour: 8, endHour: 18 },
    },
  ],
  restaurant: [
    {
      id: "lunch-dinner",
      label: "Lunch and dinner",
      hint: "Every day 11 am to 2 pm and 5 pm to 9 pm, when people decide where to eat.",
      schedule: { days: EVERY_DAY, startHour: 11, endHour: 14, extraWindows: [{ days: EVERY_DAY, startHour: 17, endHour: 21 }] },
    },
    {
      id: "dinner",
      label: "Dinner only",
      hint: "Every day 4 pm to 9 pm.",
      schedule: { days: EVERY_DAY, startHour: 16, endHour: 21 },
    },
  ],
};

export function schedulePresets(key: CategoryKey | null): readonly SchedulePreset[] {
  return key ? (SCHEDULE_PRESETS[key] ?? []) : [];
}
// </shared>

// Browser mirror of api/src/lib/schedule/policy.ts: the ad schedule (days +
// one hour window, plus up to two extra windows since 2026-11-20). The API
// validates and normalises; this copy drives the "When it shows" card.
// null = every day, all day.

export const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Day = (typeof DAYS)[number];
export type ScheduleWindow = { days: Day[]; startHour: number; endHour: number };
export type AdSchedule = ScheduleWindow & { extraWindows?: ScheduleWindow[] };

/** The main window + up to 2 more (api MAX_EXTRA_WINDOWS). */
export const MAX_EXTRA_WINDOWS = 2;

export const DAY_LABEL: Record<Day, string> = {
  mon: "Mon",
  tue: "Tue",
  wed: "Wed",
  thu: "Thu",
  fri: "Fri",
  sat: "Sat",
  sun: "Sun",
};

/** "9 am", "12 pm", "midnight" (24 and 0). */
export function hourLabel(h: number): string {
  if (h === 0 || h === 24) return "midnight";
  if (h === 12) return "noon";
  return h < 12 ? `${h} am` : `${h - 12} pm`;
}

const sortDays = (days: readonly Day[]): Day[] => DAYS.filter((d) => days.includes(d));

/** Every window, the main one first. */
export function scheduleWindows(s: AdSchedule): ScheduleWindow[] {
  return [{ days: s.days, startHour: s.startHour, endHour: s.endHour }, ...(s.extraWindows ?? [])];
}

/** True when two windows share a day and their hours overlap (the API refuses it). */
export function windowsOverlap(windows: readonly ScheduleWindow[]): boolean {
  for (let i = 0; i < windows.length; i++) {
    for (let j = i + 1; j < windows.length; j++) {
      const a = windows[i]!;
      const b = windows[j]!;
      if (!a.days.some((d) => b.days.includes(d))) continue;
      if (a.startHour < b.endHour && b.startHour < a.endHour) return true;
    }
  }
  return false;
}

/** Every day + 0-24 with no extra window is the same as no schedule. Days in week order. */
export function normalizeSchedule(s: AdSchedule | null | undefined): AdSchedule | null {
  if (!s) return null;
  const days = sortDays(s.days);
  const extra = (s.extraWindows ?? []).map((w) => ({ days: sortDays(w.days), startHour: w.startHour, endHour: w.endHour }));
  if (extra.length === 0 && days.length === 7 && s.startHour === 0 && s.endHour === 24) return null;
  return { days, startHour: s.startHour, endHour: s.endHour, ...(extra.length ? { extraWindows: extra } : {}) };
}

function describeWindow(w: ScheduleWindow): string {
  const weekdays = ["mon", "tue", "wed", "thu", "fri"];
  const days =
    w.days.length === 7
      ? "Every day"
      : w.days.length === 5 && weekdays.every((d) => w.days.includes(d as Day))
        ? "Mon–Fri"
        : w.days.length === 2 && w.days.includes("sat") && w.days.includes("sun")
          ? "Weekends"
          : sortDays(w.days).map((d) => DAY_LABEL[d]).join(", ");
  const hours = w.startHour === 0 && w.endHour === 24 ? "all day" : `${hourLabel(w.startHour)} to ${hourLabel(w.endHour)}`;
  return `${days}, ${hours}`;
}

/**
 * "Every day, all day" / "Mon–Fri, 9 am to 5 pm" / "Every day, 11 am to 2 pm
 * and 5 pm to 9 pm" / "Mon–Fri, 5 pm to midnight; Weekends, all day".
 */
export function describeSchedule(s: AdSchedule | null | undefined): string {
  const n = normalizeSchedule(s);
  if (!n) return "Every day, all day";
  const windows = scheduleWindows(n);
  // Same days in every window: say the days once.
  const sameDays = windows.every((w) => w.days.join() === windows[0]!.days.join());
  if (sameDays && windows.length > 1) {
    const [days] = describeWindow(windows[0]!).split(", ");
    return `${days}, ${windows.map((w) => (w.startHour === 0 && w.endHour === 24 ? "all day" : `${hourLabel(w.startHour)} to ${hourLabel(w.endHour)}`)).join(" and ")}`;
  }
  return windows.map(describeWindow).join("; ");
}

/** The time zone the hours are read in: the ad account's (we create US accounts in New York time). */
export function scheduleTimeZoneNote(currency: string): string {
  return currency === "INR"
    ? "Times are India time (your ad account's time zone)."
    : "Times are New York time (Eastern), your ad account's time zone.";
}

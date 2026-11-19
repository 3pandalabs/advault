// Browser mirror of api/src/lib/schedule/policy.ts: the ad schedule (days +
// one hour window). The API validates and normalises; this copy drives the
// "When it shows" card. null = every day, all day.

export const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Day = (typeof DAYS)[number];
export type AdSchedule = { days: Day[]; startHour: number; endHour: number };

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

/** Every day + 0-24 is the same as no schedule. Days in week order. */
export function normalizeSchedule(s: AdSchedule | null | undefined): AdSchedule | null {
  if (!s) return null;
  const set = new Set(s.days);
  const days = DAYS.filter((d) => set.has(d));
  if (days.length === 7 && s.startHour === 0 && s.endHour === 24) return null;
  return { days, startHour: s.startHour, endHour: s.endHour };
}

/** "Every day, all day" / "Mon–Fri, 9 am to 5 pm" / "Sat, Sun, all day". */
export function describeSchedule(s: AdSchedule | null | undefined): string {
  const n = normalizeSchedule(s);
  if (!n) return "Every day, all day";
  const weekdays = ["mon", "tue", "wed", "thu", "fri"];
  const days =
    n.days.length === 7
      ? "Every day"
      : n.days.length === 5 && weekdays.every((d) => n.days.includes(d as Day))
        ? "Mon–Fri"
        : n.days.map((d) => DAY_LABEL[d]).join(", ");
  const hours = n.startHour === 0 && n.endHour === 24 ? "all day" : `${hourLabel(n.startHour)} to ${hourLabel(n.endHour)}`;
  return `${days}, ${hours}`;
}

/** The time zone the hours are read in: the ad account's (we create US accounts in New York time). */
export function scheduleTimeZoneNote(currency: string): string {
  return currency === "INR"
    ? "Times are India time (your ad account's time zone)."
    : "Times are New York time (Eastern), your ad account's time zone.";
}

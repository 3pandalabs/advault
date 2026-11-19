import { z } from "zod";

// ---------------------------------------------------------------------------
// Ad schedule: which days, and which hours of those days, the ad may show
// (2026-11-20, migration 0037). Pure, tested (policy.test.ts); mirrored for
// the browser in web/src/lib/schedule.ts.
//
// Default (NULL) is every day, all day. A schedule is a set of days plus ONE
// time window applied to each of them, e.g. Mon-Fri 9:00-17:00. Kept that
// simple on purpose: a local shop's question is "only when we're open?", not
// a per-day grid. No overnight windows (end must be after start).
//
// At Google it is one CampaignCriterion AdSchedule per chosen day (whole
// hours, minute ZERO). Hours are in the AD ACCOUNT's time zone, which is
// America/New_York for US accounts we create (Asia/Kolkata for India); the UI
// says so. Accepted by Google for DEMAND_GEN campaigns, upgraded targeting
// on and off, in validateOnly mutates against the test customer on
// 2026-11-20. Google allows up to 6 windows a day.
//
// Since 2026-11-20 a schedule may also carry up to two `extraWindows` (each
// its own days + hours) for shapes one window can't say: a restaurant's lunch
// and dinner, or weekday evenings plus all weekend (lib/categories/
// schedulePresets.ts). Windows may not overlap on a day (Google refuses
// that). The main window's fields are unchanged, so older readers still work.
// ---------------------------------------------------------------------------

export const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Day = (typeof DAYS)[number];

const GOOGLE_DAY: Record<Day, string> = {
  mon: "MONDAY",
  tue: "TUESDAY",
  wed: "WEDNESDAY",
  thu: "THURSDAY",
  fri: "FRIDAY",
  sat: "SATURDAY",
  sun: "SUNDAY",
};

const hourWindow = {
  days: z
    .array(z.enum(DAYS))
    .min(1)
    .max(7)
    .refine((d) => new Set(d).size === d.length, { message: "duplicate day" }),
  startHour: z.number().int().min(0).max(23),
  endHour: z.number().int().min(1).max(24),
};

/** One more window on top of the main one. */
export const scheduleWindowSchema = z
  .object(hourWindow)
  .strict()
  .refine((s) => s.endHour > s.startHour, { message: "endHour must be after startHour", path: ["endHour"] });
export type ScheduleWindow = z.infer<typeof scheduleWindowSchema>;

/** The main window + up to 2 more (Google's limit is 6 a day). */
export const MAX_EXTRA_WINDOWS = 2;

/** True when two windows share a day and their hours overlap. */
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

export const adScheduleSchema = z
  .object({
    ...hourWindow,
    extraWindows: z.array(scheduleWindowSchema).max(MAX_EXTRA_WINDOWS).optional(),
  })
  .strict()
  .refine((s) => s.endHour > s.startHour, { message: "endHour must be after startHour", path: ["endHour"] })
  .refine((s) => !windowsOverlap(scheduleWindows(s)), { message: "windows overlap on the same day", path: ["extraWindows"] });

export type AdSchedule = z.infer<typeof adScheduleSchema>;

/** Every window of a schedule, the main one first. */
export function scheduleWindows(s: ScheduleWindow & { extraWindows?: ScheduleWindow[] }): ScheduleWindow[] {
  return [{ days: s.days, startHour: s.startHour, endHour: s.endHour }, ...(s.extraWindows ?? [])];
}

const sortDays = (days: readonly Day[]): Day[] => {
  const set = new Set(days);
  return DAYS.filter((d) => set.has(d));
};

/**
 * Canonical stored form: days in week order, `extraWindows` only when there
 * are some. Every day + 0-24 with no extra window is "always", stored as
 * NULL so no pointless criteria go to Google.
 */
export function normalizeAdSchedule(s: AdSchedule | null | undefined): AdSchedule | null {
  if (!s) return null;
  const days = sortDays(s.days);
  const extra = (s.extraWindows ?? []).map((w) => ({ days: sortDays(w.days), startHour: w.startHour, endHour: w.endHour }));
  if (extra.length === 0 && days.length === 7 && s.startHour === 0 && s.endHour === 24) return null;
  return { days, startHour: s.startHour, endHour: s.endHour, ...(extra.length ? { extraWindows: extra } : {}) };
}

export type AdScheduleInfo = {
  dayOfWeek: string;
  startHour: number;
  startMinute: "ZERO";
  endHour: number;
  endMinute: "ZERO";
};

/** Google AdScheduleInfo per chosen day. [] = always (no criteria). */
export function adScheduleCriteria(s: AdSchedule | null | undefined): AdScheduleInfo[] {
  const n = normalizeAdSchedule(s);
  if (!n) return [];
  // Day by day in week order, earliest window first within a day.
  const windows = scheduleWindows(n);
  return DAYS.flatMap((d) =>
    windows
      .filter((w) => w.days.includes(d))
      .sort((a, b) => a.startHour - b.startHour)
      .map((w) => ({
        dayOfWeek: GOOGLE_DAY[d],
        startHour: w.startHour,
        startMinute: "ZERO" as const,
        endHour: w.endHour,
        endMinute: "ZERO" as const,
      })),
  );
}

/** Same criterion? (Used to leave unchanged ones alone on an edit.) */
export function scheduleKey(c: { dayOfWeek?: string; startHour?: number; endHour?: number; startMinute?: string; endMinute?: string }): string {
  return `${c.dayOfWeek}|${c.startHour ?? 0}:${c.startMinute ?? "ZERO"}|${c.endHour ?? 0}:${c.endMinute ?? "ZERO"}`;
}


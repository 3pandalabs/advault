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
// 2026-11-20. Google allows up to 6 windows a day; we send one.
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

export const adScheduleSchema = z
  .object({
    days: z
      .array(z.enum(DAYS))
      .min(1)
      .max(7)
      .refine((d) => new Set(d).size === d.length, { message: "duplicate day" }),
    startHour: z.number().int().min(0).max(23),
    endHour: z.number().int().min(1).max(24),
  })
  .strict()
  .refine((s) => s.endHour > s.startHour, { message: "endHour must be after startHour", path: ["endHour"] });

export type AdSchedule = z.infer<typeof adScheduleSchema>;

/**
 * Canonical stored form: days in week order. Every day + 0-24 is "always",
 * stored as NULL so no pointless criteria go to Google.
 */
export function normalizeAdSchedule(s: AdSchedule | null | undefined): AdSchedule | null {
  if (!s) return null;
  const set = new Set(s.days);
  const days = DAYS.filter((d) => set.has(d));
  if (days.length === 7 && s.startHour === 0 && s.endHour === 24) return null;
  return { days, startHour: s.startHour, endHour: s.endHour };
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
  return n.days.map((d) => ({
    dayOfWeek: GOOGLE_DAY[d],
    startHour: n.startHour,
    startMinute: "ZERO",
    endHour: n.endHour,
    endMinute: "ZERO",
  }));
}

/** Same criterion? (Used to leave unchanged ones alone on an edit.) */
export function scheduleKey(c: { dayOfWeek?: string; startHour?: number; endHour?: number; startMinute?: string; endMinute?: string }): string {
  return `${c.dayOfWeek}|${c.startHour ?? 0}:${c.startMinute ?? "ZERO"}|${c.endHour ?? 0}:${c.endMinute ?? "ZERO"}`;
}


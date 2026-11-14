// The low-balance rule for prepaid vendors (fal). Pure, so it is tested
// without a database or a network; render/falBalanceWatch.ts feeds it.
//
// The threshold follows usage instead of being a fixed number: it is
// RUNWAY_DAYS of the recent average daily spend, never below FLOOR. A quiet
// week keeps it at the floor; a busy one raises it, so the warning always
// comes with about a week to top up.

export const RUNWAY_DAYS = Number(process.env.FAL_ALERT_RUNWAY_DAYS ?? 7);
export const FLOOR = Number(process.env.FAL_ALERT_FLOOR_USD ?? 5);
/** Critical: under this many days of spend left, or under CRITICAL_FLOOR. */
export const CRITICAL_DAYS = 2;
export const CRITICAL_FLOOR = 2;
/** Spend rate looks back this far. */
export const WINDOW_DAYS = 14;
/** While still low, the alert repeats this often. */
export const REALERT_HOURS = 24;

export type Reading = { balance: number; at: Date };
export type Level = "ok" | "low" | "critical";

const DAY = 86_400_000;

/**
 * Average daily spend over the window: the sum of every drop between
 * consecutive readings (a rise is a top-up, not negative spend) divided by
 * the days covered. Null until there are 6+ hours of readings.
 */
export function dailyBurn(readings: Reading[], now: Date = new Date()): number | null {
  const r = readings
    .filter((x) => now.getTime() - x.at.getTime() <= WINDOW_DAYS * DAY)
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  if (r.length < 2) return null;
  const spanDays = (r[r.length - 1].at.getTime() - r[0].at.getTime()) / DAY;
  if (spanDays < 0.25) return null;
  let spent = 0;
  for (let i = 1; i < r.length; i++) spent += Math.max(0, r[i - 1].balance - r[i].balance);
  // A span under a day still averages per day, but over at least one day so
  // a single busy hour doesn't extrapolate to a huge daily rate.
  return spent / Math.max(1, spanDays);
}

export type Assessment = {
  level: Level;
  threshold: number;
  critical: number;
  burnPerDay: number | null;
  /** Days left at the current rate; null when there is no spend yet. */
  runwayDays: number | null;
};

export function assess(balance: number, burnPerDay: number | null): Assessment {
  const burn = burnPerDay ?? 0;
  const threshold = Math.max(FLOOR, RUNWAY_DAYS * burn);
  const critical = Math.max(CRITICAL_FLOOR, CRITICAL_DAYS * burn);
  const level: Level = balance < critical ? "critical" : balance < threshold ? "low" : "ok";
  return {
    level,
    threshold: round2(threshold),
    critical: round2(critical),
    burnPerDay: burnPerDay === null ? null : round2(burnPerDay),
    runwayDays: burn > 0 ? Math.round((balance / burn) * 10) / 10 : null,
  };
}

const RANK: Record<Level, number> = { ok: 0, low: 1, critical: 2 };

/**
 * Whether this reading should page: when the level gets worse, and again
 * every REALERT_HOURS while it stays low or critical. Recovery to ok is
 * reported once too ("topped up"), so the alert is never left hanging.
 */
export function shouldAlert(
  level: Level,
  previous: { level: Level; lastAlertAt: Date | null } | null,
  now: Date = new Date(),
): "worse" | "repeat" | "recovered" | null {
  const prev = previous?.level ?? "ok";
  if (RANK[level] > RANK[prev]) return "worse";
  if (level === "ok") return prev !== "ok" ? "recovered" : null;
  const last = previous?.lastAlertAt?.getTime() ?? 0;
  return now.getTime() - last >= REALERT_HOURS * 3_600_000 ? "repeat" : null;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

import { formatMinor, type Currency } from "../pricing/index.js";
import { summarise, sumCounts, type MetricCounts } from "./policy.js";
import {
  aggregateBreakdown,
  costPerClick,
  dayOfWeek,
  daysLeftAtPace,
  type BreakdownItem,
  type ResultsRange,
} from "./segments.js";

// Pure half of GET /campaigns/:id/results ("How your ad is doing",
// 2026-11-19): stored rows in, the response shape out. results.ts does the I/O.

export const RESULTS_NOTE =
  "Google's numbers arrive about 3 hours late, and the last few days can still change.";

type DailyRow = MetricCounts & { date: string; updatedAt: Date };
type SegRow = MetricCounts & { dimension: string; segment: string; label: string | null; updatedAt: Date };

export function assembleResults(args: {
  range: ResultsRange;
  since: string;
  currency: Currency;
  daily: DailyRow[];
  segments: SegRow[];
  /** Wallet balance when the AdVault ad budget pays (platform billing), else null. */
  balanceMinor: number | null;
  dailyBudgetMinor: number;
  /** Spend per day over the last 7 days (for "days left at current pace"), any range. */
  recentDailySpendMinor: number[];
}) {
  const { currency } = args;
  const counts = sumCounts(args.daily);
  const totals = args.daily.length ? summarise(counts, currency) : null;
  const cpc = costPerClick(counts, currency);

  const seg = (dimension: string) => args.segments.filter((s) => s.dimension === dimension);
  const breakdown = (dimension: Parameters<typeof aggregateBreakdown>[0], rows: SegRow[], limit?: number) =>
    aggregateBreakdown(dimension, rows, currency, { limit });

  // Areas: ZIP codes when Google reports them, else cities. Top 5.
  const postal = breakdown("postal", seg("postal"), 5);
  const location = postal ?? breakdown("city", seg("city"), 5);

  // Hours in clock order (all 24 when any), days of week Sunday..Saturday.
  const hours = aggregateBreakdown("hour", seg("hour"), currency, { order: "segment" });
  const days = aggregateBreakdown(
    "dayOfWeek",
    args.daily.map((d) => ({ ...d, segment: String(dayOfWeek(d.date)) })),
    currency,
    { order: "segment" },
  );

  const lastSyncedAt = [...args.daily, ...args.segments].reduce<Date | null>(
    (latest, r) => (!latest || r.updatedAt > latest ? r.updatedAt : latest),
    null,
  );

  return {
    range: args.range,
    since: args.since,
    currency,
    note: RESULTS_NOTE,
    totals: totals && {
      ...totals,
      costMicros: counts.costMicros,
      costPerClickMinor: cpc.minor,
      costPerClickDisplay: cpc.display,
    },
    balance:
      args.balanceMinor === null
        ? null
        : {
            balanceMinor: args.balanceMinor,
            display: formatMinor(args.balanceMinor, currency),
            daysLeft: daysLeftAtPace({
              balanceMinor: args.balanceMinor,
              recentDailySpendMinor: args.recentDailySpendMinor,
              dailyBudgetMinor: args.dailyBudgetMinor,
            }),
          },
    trend: args.daily.map((d) => {
      const s = summarise(d, currency);
      return { date: d.date, views: s.views, clicks: s.clicks, spendMinor: s.spendMinor, costPerViewMinor: s.costPerViewMinor };
    }),
    // null = Google reported nothing for it (yet, or withheld for privacy).
    breakdowns: {
      age: breakdown("age", seg("age")),
      gender: breakdown("gender", seg("gender")),
      device: breakdown("device", seg("device")),
      network: breakdown("network", seg("network")),
      location,
      hour: hours,
      dayOfWeek: days,
    } satisfies Record<string, BreakdownItem[] | null>,
    lastSyncedAt: lastSyncedAt?.toISOString() ?? null,
  };
}


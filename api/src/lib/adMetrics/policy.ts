import { formatMinor, MINOR_PER_MAJOR, type Currency } from "../pricing/index.js";

// Pure half of ad performance analytics: the GAQL we send, how a response row
// becomes a daily row, and the arithmetic behind every derived number the
// dashboard shows. No db, no fetch — the sibling index.ts does the I/O.
//
// FIELD CHOICE (pinned API version, see lib/googleAds/env.ts):
//  - metrics.impressions, metrics.clicks, metrics.cost_micros — standard.
//  - metrics.video_trueview_views — the video-view count. The old
//    metrics.video_views (and video_view_rate / average_cpv) was REMOVED in
//    v22 and replaced by the video_trueview_* family; selecting the old name
//    on the pinned version is a 400 for the whole query.
//  - Derived rates (CTR, view rate, cost per view) are deliberately NOT
//    selected from Google. Google's per-row averages cannot be summed across
//    days, and computing them from the summed counts gives the right number
//    for any range with one code path.

export const METRIC_FIELDS = [
  "metrics.impressions",
  "metrics.video_trueview_views",
  "metrics.clicks",
  "metrics.cost_micros",
] as const;

const MICROS_PER_MINOR = 1_000_000 / MINOR_PER_MAJOR;

/** YYYY-MM-DD in UTC, `days` before `now` (negative = after). */
export function isoDaysAgo(days: number, now: Date = new Date()): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Per-campaign, per-day metrics for one customer. Read-only (googleAds:search).
 *
 * A closed BETWEEN range rather than an open `>=`: Google requires a finite
 * date range whenever segments.date is selected. Days with no activity simply
 * produce no row.
 */
export function buildDailyMetricsQuery(sinceDate: string, untilDate: string): string {
  if (!ISO_DATE.test(sinceDate) || !ISO_DATE.test(untilDate)) {
    // Dates are interpolated into GAQL; refuse anything that isn't a date.
    throw new Error(`invalid date range ${sinceDate}..${untilDate}`);
  }
  return (
    `SELECT campaign.resource_name, segments.date, ${METRIC_FIELDS.join(", ")} ` +
    "FROM campaign " +
    `WHERE segments.date BETWEEN '${sinceDate}' AND '${untilDate}'`
  );
}

export type DailyMetricsRow = {
  campaignResourceName: string;
  date: string;
  impressions: number;
  views: number;
  clicks: number;
  costMicros: number;
};

/** One element of a googleAds:search `results` array, as the REST API returns it (camelCase, int64 as strings). */
export type GaqlMetricsResult = {
  campaign?: { resourceName?: string };
  segments?: { date?: string };
  metrics?: {
    impressions?: string | number;
    videoTrueviewViews?: string | number;
    clicks?: string | number;
    costMicros?: string | number;
  };
};

function count(v: string | number | undefined): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/** Maps search results to daily rows, dropping anything without a campaign or a date. */
export function parseDailyMetricsResults(results: GaqlMetricsResult[] | undefined): DailyMetricsRow[] {
  return (results ?? [])
    .filter((r) => r.campaign?.resourceName && r.segments?.date && ISO_DATE.test(r.segments.date))
    .map((r) => ({
      campaignResourceName: r.campaign!.resourceName!,
      date: r.segments!.date!,
      impressions: count(r.metrics?.impressions),
      views: count(r.metrics?.videoTrueviewViews),
      clicks: count(r.metrics?.clicks),
      costMicros: count(r.metrics?.costMicros),
    }));
}

export type MetricCounts = {
  impressions: number;
  views: number;
  clicks: number;
  costMicros: number;
};

export function sumCounts(rows: MetricCounts[]): MetricCounts {
  return rows.reduce<MetricCounts>(
    (acc, r) => ({
      impressions: acc.impressions + r.impressions,
      views: acc.views + r.views,
      clicks: acc.clicks + r.clicks,
      costMicros: acc.costMicros + r.costMicros,
    }),
    { impressions: 0, views: 0, clicks: 0, costMicros: 0 },
  );
}

export function microsToMinor(micros: number): number {
  return Math.round(micros / MICROS_PER_MINOR);
}

export type MetricSummary = {
  impressions: number;
  views: number;
  clicks: number;
  spendMinor: number;
  spendDisplay: string;
  /** null when there were no views — a cost per zero views is not a number worth showing. */
  costPerViewMinor: number | null;
  costPerViewDisplay: string | null;
  /** clicks / impressions, 0..1; null with no impressions. */
  ctr: number | null;
  /** views / impressions, 0..1; null with no impressions. */
  viewRate: number | null;
};

/**
 * Derived numbers from summed counts, in the campaign's currency.
 *
 * Cost per view is computed from micros, not from rounded minor units, so a
 * $4.99 spend over 1,000 views is 0.499¢ → shown as "<$0.01" rather than
 * rounding a real cost to a free-looking $0.
 */
export function summarise(c: MetricCounts, currency: Currency): MetricSummary {
  const spendMinor = microsToMinor(c.costMicros);
  let costPerViewMinor: number | null = null;
  let costPerViewDisplay: string | null = null;
  if (c.views > 0) {
    costPerViewMinor = microsToMinor(c.costMicros / c.views);
    costPerViewDisplay =
      costPerViewMinor === 0 && c.costMicros > 0
        ? `<${formatMinor(1, currency)}`
        : formatMinor(costPerViewMinor, currency);
  }
  return {
    impressions: c.impressions,
    views: c.views,
    clicks: c.clicks,
    spendMinor,
    spendDisplay: formatMinor(spendMinor, currency),
    costPerViewMinor,
    costPerViewDisplay,
    ctr: c.impressions > 0 ? c.clicks / c.impressions : null,
    viewRate: c.impressions > 0 ? c.views / c.impressions : null,
  };
}

export const DEFAULT_RANGE_DAYS = 7;
export const MAX_RANGE_DAYS = 90;

/** Clamps a requested range to 1..MAX_RANGE_DAYS, defaulting to DEFAULT_RANGE_DAYS. */
export function clampRangeDays(days: unknown): number {
  const n = Math.floor(Number(days));
  if (!Number.isFinite(n) || n < 1) return DEFAULT_RANGE_DAYS;
  return Math.min(n, MAX_RANGE_DAYS);
}

/**
 * The inclusive [since, until] window for an N-day range ending today (UTC).
 * `until` is tomorrow so an account whose timezone is ahead of UTC (Asia/Kolkata)
 * still sees its own "today".
 */
export function rangeFor(days: number, now: Date = new Date()): { since: string; until: string } {
  return { since: isoDaysAgo(days - 1, now), until: isoDaysAgo(-1, now) };
}

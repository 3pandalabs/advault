import { formatMinor, type Currency } from "../pricing/index.js";
import { METRIC_FIELDS, microsToMinor, summarise, sumCounts, type MetricCounts, type MetricSummary } from "./policy.js";

// Pure half of the results screen's breakdowns (2026-11-19, migration 0035):
// who saw the ad (age, gender, device), where (area, network) and when
// (hour; day of week comes from campaign_daily_metrics dates). No db, no
// fetch: render/adMetricsSync.ts runs these READ-ONLY searches and
// lib/adMetrics/index.ts stores them in campaign_segment_metrics.
//
// FIELD NAMES were checked against the pinned API version with one read-only
// googleAds:search each on 2026-11-19 (test customer 8749788831 via the MCC):
// Google accepted every query below (no UNRECOGNIZED_FIELD / prohibited
// segment). The account had no campaign, so the result SHAPES are from the
// REST reference (camelCase, int64 as strings, proto3 JSON omits zero/default
// values: an hour of 0 arrives as a missing `hour`).
//
// Caveat worth knowing: age_range_view / gender_view report per age/gender
// CRITERION. Demand Gen targets demographics through one Audience, not
// criteria, so these may stay empty for our campaigns; the UI then says "Not
// enough views yet" instead of zeros.

export const SEGMENT_DIMENSIONS = ["age", "gender", "device", "network", "hour", "postal", "city"] as const;
export type SegmentDimension = (typeof SEGMENT_DIMENSIONS)[number];

type Spec = { from: string; field: string; pick: (r: GaqlSegmentResult) => string | null };

const SPECS: Record<SegmentDimension, Spec> = {
  age: { from: "age_range_view", field: "ad_group_criterion.age_range.type", pick: (r) => r.adGroupCriterion?.ageRange?.type ?? null },
  gender: { from: "gender_view", field: "ad_group_criterion.gender.type", pick: (r) => r.adGroupCriterion?.gender?.type ?? null },
  device: { from: "campaign", field: "segments.device", pick: (r) => r.segments?.device ?? null },
  network: { from: "campaign", field: "segments.ad_network_type", pick: (r) => r.segments?.adNetworkType ?? null },
  // proto3 JSON drops 0, so a row with no `hour` is midnight.
  hour: { from: "campaign", field: "segments.hour", pick: (r) => String(Number(r.segments?.hour ?? 0)) },
  postal: { from: "user_location_view", field: "segments.geo_target_postal_code", pick: (r) => r.segments?.geoTargetPostalCode ?? null },
  city: { from: "user_location_view", field: "segments.geo_target_city", pick: (r) => r.segments?.geoTargetCity ?? null },
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The read-only GAQL for one breakdown over a closed date range. */
export function buildSegmentQuery(dimension: SegmentDimension, sinceDate: string, untilDate: string): string {
  if (!ISO_DATE.test(sinceDate) || !ISO_DATE.test(untilDate)) {
    throw new Error(`invalid date range ${sinceDate}..${untilDate}`);
  }
  const s = SPECS[dimension];
  return (
    `SELECT campaign.resource_name, segments.date, ${s.field}, ${METRIC_FIELDS.join(", ")} ` +
    `FROM ${s.from} ` +
    `WHERE segments.date BETWEEN '${sinceDate}' AND '${untilDate}'`
  );
}

export type GaqlSegmentResult = {
  campaign?: { resourceName?: string };
  adGroupCriterion?: { ageRange?: { type?: string }; gender?: { type?: string } };
  segments?: {
    date?: string;
    device?: string;
    adNetworkType?: string;
    hour?: number | string;
    geoTargetPostalCode?: string;
    geoTargetCity?: string;
  };
  metrics?: {
    impressions?: string | number;
    videoTrueviewViews?: string | number;
    clicks?: string | number;
    costMicros?: string | number;
  };
};

export type SegmentRow = MetricCounts & { campaignResourceName: string; date: string; segment: string };

function count(v: string | number | undefined): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/**
 * Search results → one row per (campaign, date, segment). Rows Google splits
 * further (age/gender report per ad group) are summed. Rows with no campaign,
 * date or segment value, or with no activity at all, are dropped.
 */
export function parseSegmentResults(dimension: SegmentDimension, results: GaqlSegmentResult[] | undefined): SegmentRow[] {
  const spec = SPECS[dimension];
  const merged = new Map<string, SegmentRow>();
  for (const r of results ?? []) {
    const campaignResourceName = r.campaign?.resourceName;
    const date = r.segments?.date;
    const segment = spec.pick(r);
    if (!campaignResourceName || !date || !ISO_DATE.test(date) || !segment) continue;
    const c = {
      impressions: count(r.metrics?.impressions),
      views: count(r.metrics?.videoTrueviewViews),
      clicks: count(r.metrics?.clicks),
      costMicros: count(r.metrics?.costMicros),
    };
    if (!c.impressions && !c.views && !c.clicks && !c.costMicros) continue;
    const key = `${campaignResourceName}|${date}|${segment}`;
    const prev = merged.get(key);
    merged.set(
      key,
      prev
        ? { ...prev, ...sumCounts([prev, c]) }
        : { campaignResourceName, date, segment, ...c },
    );
  }
  return [...merged.values()];
}

/** geoTargetConstants/... ids referenced by location rows, for one name lookup. */
export function geoConstantIds(rows: { segment: string }[]): string[] {
  return [...new Set(rows.map((r) => r.segment).filter((s) => /^geoTargetConstants\/\d+$/.test(s)))];
}

/** Read-only lookup of place names for geo target constants. */
export function buildGeoNameQuery(resourceNames: string[]): string {
  const safe = resourceNames.filter((s) => /^geoTargetConstants\/\d+$/.test(s));
  return (
    "SELECT geo_target_constant.resource_name, geo_target_constant.name, geo_target_constant.canonical_name " +
    `FROM geo_target_constant WHERE geo_target_constant.resource_name IN (${safe.map((s) => `'${s}'`).join(", ")})`
  );
}

export type GaqlGeoResult = { geoTargetConstant?: { resourceName?: string; name?: string; canonicalName?: string } };

/** "10001" stays "10001, New York"; a city becomes "Brooklyn, New York" (name + region). */
export function geoLabels(results: GaqlGeoResult[] | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of results ?? []) {
    const g = r.geoTargetConstant;
    if (!g?.resourceName || !g.name) continue;
    const parts = (g.canonicalName ?? "").split(",").map((p) => p.trim()).filter(Boolean);
    const region = parts.length >= 3 ? parts[parts.length - 2] : null;
    const city = parts.length >= 4 ? parts[1] : null;
    out.set(g.resourceName, [g.name, city, region].filter((x, i, a) => x && a.indexOf(x) === i).slice(0, 2).join(", "));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Labels: plain words, never Google enums.
// ---------------------------------------------------------------------------

const AGE: Record<string, string> = {
  AGE_RANGE_18_24: "18–24",
  AGE_RANGE_25_34: "25–34",
  AGE_RANGE_35_44: "35–44",
  AGE_RANGE_45_54: "45–54",
  AGE_RANGE_55_64: "55–64",
  AGE_RANGE_65_UP: "65+",
  AGE_RANGE_UNDETERMINED: "Unknown",
};
const GENDER: Record<string, string> = { MALE: "Men", FEMALE: "Women", UNDETERMINED: "Unknown" };
const DEVICE: Record<string, string> = {
  MOBILE: "Phones",
  TABLET: "Tablets",
  DESKTOP: "Computers",
  CONNECTED_TV: "TV screens",
  OTHER: "Other",
};
const NETWORK: Record<string, string> = {
  YOUTUBE: "YouTube",
  YOUTUBE_SEARCH: "YouTube",
  YOUTUBE_WATCH: "YouTube",
  GOOGLE_TV: "Google TV",
  GOOGLE_OWNED_CHANNELS: "Discover and Gmail",
  CONTENT: "Partner sites and apps",
  SEARCH: "Google Search",
  SEARCH_PARTNERS: "Search partners",
  MIXED: "Several places",
};

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function hourLabel(h: number): string {
  if (h === 0) return "12am";
  if (h === 12) return "12pm";
  return h < 12 ? `${h}am` : `${h - 12}pm`;
}

export const DAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function segmentLabel(dimension: SegmentDimension | "dayOfWeek", segment: string, stored?: string | null): string {
  if (stored) return stored;
  switch (dimension) {
    case "age":
      return AGE[segment] ?? titleCase(segment.replace(/^AGE_RANGE_/, ""));
    case "gender":
      return GENDER[segment] ?? titleCase(segment);
    case "device":
      return DEVICE[segment] ?? titleCase(segment);
    case "network":
      return NETWORK[segment] ?? titleCase(segment);
    case "hour":
      return hourLabel(Number(segment));
    case "dayOfWeek":
      return DAY_LABELS[Number(segment)] ?? segment;
    default:
      return segment.replace(/^geoTargetConstants\//, "Area ");
  }
}

// ---------------------------------------------------------------------------
// Aggregation for GET /campaigns/:id/results.
// ---------------------------------------------------------------------------

export type BreakdownItem = MetricSummary & {
  segment: string;
  label: string;
  /** Share of the breakdown's impressions, 0..1. */
  share: number;
};

/**
 * Sums stored rows per segment into a sorted breakdown. null when Google
 * reported nothing (none yet, or withheld under its privacy thresholds) so
 * the UI says "Not enough views yet" rather than drawing zeros. Rows whose
 * segment Google could not determine ("Unknown") are kept but sorted last.
 */
export function aggregateBreakdown(
  dimension: SegmentDimension | "dayOfWeek",
  rows: (MetricCounts & { segment: string; label?: string | null })[],
  currency: Currency,
  opts: { order?: "impressions" | "segment"; limit?: number } = {},
): BreakdownItem[] | null {
  const bySegment = new Map<string, { counts: MetricCounts[]; label: string | null }>();
  for (const r of rows) {
    const cur = bySegment.get(r.segment) ?? { counts: [], label: null };
    cur.counts.push(r);
    cur.label = cur.label ?? r.label ?? null;
    bySegment.set(r.segment, cur);
  }
  const items = [...bySegment].map(([segment, v]) => {
    const c = sumCounts(v.counts);
    return { segment, label: segmentLabel(dimension, segment, v.label), counts: c };
  });
  const total = items.reduce((s, i) => s + i.counts.impressions, 0);
  if (total === 0) return null;

  const unknown = (i: { label: string }) => (i.label === "Unknown" ? 1 : 0);
  items.sort((a, b) =>
    opts.order === "segment"
      ? Number(a.segment) - Number(b.segment)
      : unknown(a) - unknown(b) || b.counts.impressions - a.counts.impressions,
  );
  const limited = opts.limit ? items.slice(0, opts.limit) : items;
  return limited.map((i) => ({
    segment: i.segment,
    label: i.label,
    share: i.counts.impressions / total,
    ...summarise(i.counts, currency),
  }));
}

/** Day of week (0 = Sunday) of a YYYY-MM-DD report date. */
export function dayOfWeek(date: string): number {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

/** Results-screen ranges. `all` starts at the launch date. */
export type ResultsRange = "7d" | "30d" | "all";

export function rangeSince(range: ResultsRange, launchedAt: Date | null, isoDaysAgo: (d: number) => string): string {
  if (range === "7d") return isoDaysAgo(6);
  if (range === "30d") return isoDaysAgo(29);
  return launchedAt ? launchedAt.toISOString().slice(0, 10) : "2000-01-01";
}

/**
 * Days of budget left at the current pace: balance / average daily spend over
 * the last 7 days with spend. Falls back to the daily budget before there is
 * any spend. null when there is no balance to speak of (customer-billed).
 */
export function daysLeftAtPace(args: {
  balanceMinor: number | null;
  recentDailySpendMinor: number[];
  dailyBudgetMinor: number;
}): number | null {
  if (args.balanceMinor === null) return null;
  if (args.balanceMinor <= 0) return 0;
  const spent = args.recentDailySpendMinor.filter((s) => s > 0);
  const pace = spent.length > 0 ? spent.reduce((a, b) => a + b, 0) / spent.length : args.dailyBudgetMinor;
  if (pace <= 0) return null;
  return Math.max(1, Math.floor(args.balanceMinor / pace));
}

/** Cost per click, from summed counts (null with no clicks). */
export function costPerClick(c: MetricCounts, currency: Currency): { minor: number | null; display: string | null } {
  if (c.clicks <= 0) return { minor: null, display: null };
  const minor = microsToMinor(c.costMicros / c.clicks);
  return { minor, display: minor === 0 && c.costMicros > 0 ? `<${formatMinor(1, currency)}` : formatMinor(minor, currency) };
}

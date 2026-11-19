import type { AudienceFilters } from "../audience/policy.js";
import { formatMinor, type Currency } from "../pricing/index.js";
import type { AdSchedule } from "../schedule/policy.js";
import type { BreakdownItem } from "./segments.js";

// ---------------------------------------------------------------------------
// Smart suggestions on the results screen (2026-11-20). Pure, tested
// (suggestions.test.ts).
//
// "35–44 get you clicks at $0.60 vs $1.10 average. Focus on them?" with a
// button that narrows the campaign through PUT /campaigns/:id/targeting
// (audience for age / gender, schedule for days / hours).
//
// CONSERVATIVE on purpose. At $5 a day a narrowed ad can stop showing, so a
// suggestion needs:
//   * enough campaign data to call an average: >= 200 times shown and
//     >= 10 clicks (twice the segment minimums), else views (>= 40) for cost
//     per view;
//   * enough segment data: >= 100 times shown and >= 5 clicks (or >= 20
//     views);
//   * a CLEAR win: the segment's cost is at most 70% of the campaign's
//     average (30%+ cheaper), and the segment is not already ~everything
//     (< 90% of spend);
//   * never "Unknown", never a dimension the campaign already narrows, never
//     age or gender for real estate (US housing policy forbids them).
// At most 2 suggestions, best first. Empty breakdowns (age/gender often stay
// empty for Demand Gen) simply produce nothing.
// ---------------------------------------------------------------------------

export const SUGGESTION_RULES = {
  campaignMinImpressions: 200,
  campaignMinClicks: 10,
  campaignMinViews: 40,
  segmentMinImpressions: 100,
  segmentMinClicks: 5,
  segmentMinViews: 20,
  maxCostRatio: 0.7,
  maxSpendShare: 0.9,
  maxSuggestions: 2,
} as const;

type Counts = { impressions: number; views: number; clicks: number; spendMinor: number };

export type Suggestion = {
  id: string;
  dimension: "age" | "gender" | "dayOfWeek" | "hour";
  metric: "click" | "view";
  label: string;
  segmentCostMinor: number;
  averageCostMinor: number;
  /** "35–44 get you clicks at $0.60 vs $1.10 average." */
  message: string;
  /** "Focus on them?" */
  question: string;
  /** Button text. */
  action: string;
  /** Body for PUT /campaigns/:id/targeting. */
  apply: { audienceFilters: AudienceFilters } | { adSchedule: AdSchedule };
  /** Always shown with the card. */
  reachWarning: string;
};

const AGE_FILTER: Record<string, NonNullable<AudienceFilters["ages"]>[number]> = {
  AGE_RANGE_18_24: "18-24",
  AGE_RANGE_25_34: "25-34",
  AGE_RANGE_35_44: "35-44",
  AGE_RANGE_45_54: "45-54",
  AGE_RANGE_55_64: "55-64",
  AGE_RANGE_65_UP: "65+",
};
const GENDER_FILTER: Record<string, "male" | "female"> = { MALE: "male", FEMALE: "female" };

const ALL_DAYS: AdSchedule["days"] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
// dayOfWeek breakdown segments: "0" = Sunday .. "6" = Saturday.
const DAY_GROUPS = [
  { id: "weekdays", label: "Weekdays", segments: ["1", "2", "3", "4", "5"], days: ["mon", "tue", "wed", "thu", "fri"] as AdSchedule["days"], action: "Weekdays only" },
  { id: "weekends", label: "Weekends", segments: ["0", "6"], days: ["sat", "sun"] as AdSchedule["days"], action: "Weekends only" },
];
// Hour blocks in the ad account's time zone (Google's segments.hour is too).
const HOUR_BLOCKS = [
  { id: "morning", label: "Mornings (6 am–noon)", start: 6, end: 12 },
  { id: "afternoon", label: "Afternoons (noon–6 pm)", start: 12, end: 18 },
  { id: "evening", label: "Evenings (6 pm–midnight)", start: 18, end: 24 },
];

/** A cost per click/view: "$1.10", "$0.04", "$0.004" (never "$0.00"). */
export function perUnit(minor: number, currency: Currency): string {
  const major = minor / 100;
  const digits = major >= 0.1 ? 2 : 3;
  return new Intl.NumberFormat(currency === "INR" ? "en-IN" : "en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(Math.max(major, 0.001));
}

function sum(items: BreakdownItem[]): Counts {
  return items.reduce<Counts>(
    (a, i) => ({
      impressions: a.impressions + i.impressions,
      views: a.views + i.views,
      clicks: a.clicks + i.clicks,
      spendMinor: a.spendMinor + i.spendMinor,
    }),
    { impressions: 0, views: 0, clicks: 0, spendMinor: 0 },
  );
}

type Candidate = { metric: "click" | "view"; segCost: number; avgCost: number; ratio: number };

/** The comparison for one segment against the campaign, or null when it isn't a clear, well-supported win. */
export function judgeSegment(seg: Counts, campaign: Counts): Candidate | null {
  const R = SUGGESTION_RULES;
  if (campaign.spendMinor <= 0 || seg.spendMinor <= 0) return null;
  if (campaign.impressions < R.campaignMinImpressions || seg.impressions < R.segmentMinImpressions) return null;
  if (seg.spendMinor / campaign.spendMinor >= R.maxSpendShare) return null;
  let metric: "click" | "view";
  if (campaign.clicks >= R.campaignMinClicks && seg.clicks >= R.segmentMinClicks) metric = "click";
  else if (campaign.views >= R.campaignMinViews && seg.views >= R.segmentMinViews) metric = "view";
  else return null;
  const n = (c: Counts) => (metric === "click" ? c.clicks : c.views);
  const segCost = seg.spendMinor / n(seg);
  const avgCost = campaign.spendMinor / n(campaign);
  const ratio = segCost / avgCost;
  return ratio <= R.maxCostRatio ? { metric, segCost, avgCost, ratio } : null;
}

export function buildSuggestions(args: {
  currency: Currency;
  totals: Counts | null;
  breakdowns: { age: BreakdownItem[] | null; gender: BreakdownItem[] | null; dayOfWeek: BreakdownItem[] | null; hour: BreakdownItem[] | null };
  housing: boolean;
  audienceFilters: AudienceFilters | null;
  adSchedule: AdSchedule | null;
  dailyBudgetMinor: number;
}): Suggestion[] {
  const { totals, currency } = args;
  if (!totals) return [];
  const money = (minor: number) => perUnit(minor, currency);
  const reachWarning = `At ${formatMinor(args.dailyBudgetMinor, currency)} a day, narrowing can make your ad show less. If views drop, widen it again.`;
  const out: (Suggestion & { ratio: number })[] = [];

  const push = (
    dimension: Suggestion["dimension"],
    id: string,
    label: string,
    c: Candidate,
    plural: boolean,
    question: string,
    action: string,
    apply: Suggestion["apply"],
  ) => {
    const what = c.metric === "click" ? "clicks" : "views";
    out.push({
      id: `${dimension}:${id}`,
      dimension,
      metric: c.metric,
      label,
      segmentCostMinor: Math.round(c.segCost),
      averageCostMinor: Math.round(c.avgCost),
      message: `${label} ${plural ? "get" : "gets"} you ${what} at ${money(c.segCost)} vs ${money(c.avgCost)} average.`,
      question,
      action,
      apply,
      reachWarning,
      ratio: c.ratio,
    });
  };

  // Best single segment of a breakdown that maps to a filter value.
  const bestOf = (items: BreakdownItem[] | null, map: Record<string, string>) => {
    let best: { item: BreakdownItem; c: Candidate } | null = null;
    for (const item of items ?? []) {
      if (!(item.segment in map)) continue; // Unknown / unmapped
      const c = judgeSegment(item, totals);
      if (c && (!best || c.ratio < best.c.ratio)) best = { item, c };
    }
    return best;
  };

  const filters = args.audienceFilters ?? {};
  if (!args.housing && !filters.ages?.length) {
    const b = bestOf(args.breakdowns.age, AGE_FILTER);
    if (b) {
      // Keeps Google's "unknown age" group: a large share of viewers, any age.
      push("age", b.item.segment, b.item.label, b.c, true, "Focus on them?", `Focus on ${b.item.label}`, {
        audienceFilters: { ...filters, ages: [AGE_FILTER[b.item.segment]!, "unknown"] },
      });
    }
  }
  if (!args.housing && !filters.genders?.length) {
    const b = bestOf(args.breakdowns.gender, GENDER_FILTER);
    if (b) {
      push("gender", b.item.segment, b.item.label, b.c, true, "Focus on them?", `Focus on ${b.item.label.toLowerCase()}`, {
        audienceFilters: { ...filters, genders: [GENDER_FILTER[b.item.segment]!, "unknown"] },
      });
    }
  }

  // Days and hours: only while the ad runs every day, all day.
  if (!args.adSchedule) {
    let bestDay: { g: (typeof DAY_GROUPS)[number]; c: Candidate } | null = null;
    for (const g of DAY_GROUPS) {
      const items = (args.breakdowns.dayOfWeek ?? []).filter((i) => g.segments.includes(i.segment));
      const c = items.length ? judgeSegment(sum(items), totals) : null;
      if (c && (!bestDay || c.ratio < bestDay.c.ratio)) bestDay = { g, c };
    }
    if (bestDay) {
      const { g, c } = bestDay;
      push("dayOfWeek", g.id, g.label, c, true, `Show it on ${g.label.toLowerCase()} only?`, g.action, {
        adSchedule: { days: g.days, startHour: 0, endHour: 24 },
      });
    }
    let bestHour: { h: (typeof HOUR_BLOCKS)[number]; c: Candidate } | null = null;
    for (const h of HOUR_BLOCKS) {
      const items = (args.breakdowns.hour ?? []).filter((i) => Number(i.segment) >= h.start && Number(i.segment) < h.end);
      const c = items.length ? judgeSegment(sum(items), totals) : null;
      if (c && (!bestHour || c.ratio < bestHour.c.ratio)) bestHour = { h, c };
    }
    if (bestHour) {
      const { h, c } = bestHour;
      const short = h.label.split(" (")[0]!;
      push("hour", h.id, h.label, c, true, `Show it in the ${short.toLowerCase()} only?`, `${short} only`, {
        adSchedule: { days: ALL_DAYS, startHour: h.start, endHour: h.end },
      });
    }
  }

  return out
    .sort((a, b) => a.ratio - b.ratio)
    .slice(0, SUGGESTION_RULES.maxSuggestions)
    .map(({ ratio: _ratio, ...s }) => s);
}

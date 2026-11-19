import { describe, expect, it } from "vitest";
import { assembleResults } from "./resultsView.js";
import {
  aggregateBreakdown,
  buildGeoNameQuery,
  buildSegmentQuery,
  costPerClick,
  dayOfWeek,
  daysLeftAtPace,
  geoConstantIds,
  geoLabels,
  hourLabel,
  parseSegmentResults,
  rangeSince,
} from "./segments.js";

const m = (impressions: string, views = "0", clicks = "0", costMicros = "0") => ({
  impressions,
  videoTrueviewViews: views,
  clicks,
  costMicros,
});
const C = "customers/1/campaigns/2";

describe("buildSegmentQuery", () => {
  it("uses the field names Google accepted on 2026-11-19", () => {
    expect(buildSegmentQuery("age", "2026-11-01", "2026-11-07")).toBe(
      "SELECT campaign.resource_name, segments.date, ad_group_criterion.age_range.type, metrics.impressions, metrics.video_trueview_views, metrics.clicks, metrics.cost_micros FROM age_range_view WHERE segments.date BETWEEN '2026-11-01' AND '2026-11-07'",
    );
    expect(buildSegmentQuery("gender", "2026-11-01", "2026-11-07")).toContain("ad_group_criterion.gender.type");
    expect(buildSegmentQuery("gender", "2026-11-01", "2026-11-07")).toContain("FROM gender_view");
    expect(buildSegmentQuery("device", "2026-11-01", "2026-11-07")).toContain("segments.device, ");
    expect(buildSegmentQuery("network", "2026-11-01", "2026-11-07")).toContain("segments.ad_network_type");
    expect(buildSegmentQuery("hour", "2026-11-01", "2026-11-07")).toContain("segments.hour");
    expect(buildSegmentQuery("postal", "2026-11-01", "2026-11-07")).toContain(
      "segments.geo_target_postal_code, metrics.impressions",
    );
    expect(buildSegmentQuery("city", "2026-11-01", "2026-11-07")).toContain("FROM user_location_view");
  });
  it("refuses anything that is not a date", () => {
    expect(() => buildSegmentQuery("device", "2026-11-01' OR 1=1", "2026-11-07")).toThrow();
  });
});

describe("parseSegmentResults", () => {
  it("maps GAQL rows to (campaign, date, segment) counts", () => {
    const rows = parseSegmentResults("device", [
      { campaign: { resourceName: C }, segments: { date: "2026-11-02", device: "MOBILE" }, metrics: m("100", "40", "3", "1200000") },
    ]);
    expect(rows).toEqual([
      { campaignResourceName: C, date: "2026-11-02", segment: "MOBILE", impressions: 100, views: 40, clicks: 3, costMicros: 1_200_000 },
    ]);
  });
  it("reads a missing hour as midnight (proto3 JSON omits 0)", () => {
    const rows = parseSegmentResults("hour", [
      { campaign: { resourceName: C }, segments: { date: "2026-11-02" }, metrics: m("10") },
      { campaign: { resourceName: C }, segments: { date: "2026-11-02", hour: 17 }, metrics: m("5") },
    ]);
    expect(rows.map((r) => r.segment)).toEqual(["0", "17"]);
  });
  it("sums rows Google splits by ad group, drops empty and malformed rows", () => {
    const rows = parseSegmentResults("age", [
      { campaign: { resourceName: C }, segments: { date: "2026-11-02" }, adGroupCriterion: { ageRange: { type: "AGE_RANGE_25_34" } }, metrics: m("10", "4") },
      { campaign: { resourceName: C }, segments: { date: "2026-11-02" }, adGroupCriterion: { ageRange: { type: "AGE_RANGE_25_34" } }, metrics: m("5", "1") },
      { campaign: { resourceName: C }, segments: { date: "2026-11-02" }, adGroupCriterion: { ageRange: { type: "AGE_RANGE_65_UP" } }, metrics: m("0") },
      { segments: { date: "2026-11-02" }, adGroupCriterion: { ageRange: { type: "AGE_RANGE_18_24" } }, metrics: m("9") },
    ]);
    expect(rows).toEqual([
      { campaignResourceName: C, date: "2026-11-02", segment: "AGE_RANGE_25_34", impressions: 15, views: 5, clicks: 0, costMicros: 0 },
    ]);
  });
  it("returns nothing for an empty or withheld report", () => {
    expect(parseSegmentResults("gender", undefined)).toEqual([]);
    expect(parseSegmentResults("gender", [])).toEqual([]);
  });
});

describe("geo names", () => {
  it("collects constant ids and builds a safe lookup", () => {
    expect(geoConstantIds([{ segment: "geoTargetConstants/9031934" }, { segment: "geoTargetConstants/9031934" }, { segment: "x' OR" }])).toEqual([
      "geoTargetConstants/9031934",
    ]);
    expect(buildGeoNameQuery(["geoTargetConstants/1", "bad'"])).toContain("IN ('geoTargetConstants/1')");
  });
  it("labels a ZIP with its city and a city with its state", () => {
    const labels = geoLabels([
      { geoTargetConstant: { resourceName: "geoTargetConstants/9031934", name: "10001", canonicalName: "10001,New York,New York,United States" } },
      { geoTargetConstant: { resourceName: "geoTargetConstants/1023191", name: "New York", canonicalName: "New York,New York,United States" } },
      { geoTargetConstant: { resourceName: "geoTargetConstants/1014221", name: "Brooklyn", canonicalName: "Brooklyn,New York,United States" } },
    ]);
    expect(labels.get("geoTargetConstants/9031934")).toBe("10001, New York");
    expect(labels.get("geoTargetConstants/1023191")).toBe("New York");
    expect(labels.get("geoTargetConstants/1014221")).toBe("Brooklyn, New York");
  });
});

describe("aggregateBreakdown", () => {
  const row = (segment: string, impressions: number, views = 0, costMicros = 0) => ({
    segment,
    impressions,
    views,
    clicks: 0,
    costMicros,
  });
  it("is null when Google reported nothing (shown as Not enough views yet)", () => {
    expect(aggregateBreakdown("age", [], "USD")).toBeNull();
    expect(aggregateBreakdown("age", [row("AGE_RANGE_25_34", 0)], "USD")).toBeNull();
  });
  it("sums across days, labels in plain words, sorts by impressions with Unknown last", () => {
    const out = aggregateBreakdown(
      "device",
      [row("MOBILE", 60, 30, 600_000), row("MOBILE", 20, 10, 200_000), row("OTHER", 5), row("CONNECTED_TV", 15, 5)],
      "USD",
    )!;
    expect(out.map((o) => [o.label, o.impressions])).toEqual([
      ["Phones", 80],
      ["TV screens", 15],
      ["Other", 5],
    ]);
    expect(out[0]!.share).toBeCloseTo(0.8);
    expect(out[0]!.costPerViewDisplay).toBe("$0.02");
    const ages = aggregateBreakdown("age", [row("AGE_RANGE_UNDETERMINED", 90), row("AGE_RANGE_35_44", 10)], "USD")!;
    expect(ages.map((a) => a.label)).toEqual(["35–44", "Unknown"]);
  });
  it("keeps clock order for hours and a top-N limit for areas", () => {
    const hrs = aggregateBreakdown("hour", [row("17", 5), row("0", 1), row("9", 3)], "USD", { order: "segment" })!;
    expect(hrs.map((h) => h.label)).toEqual(["12am", "9am", "5pm"]);
    const areas = aggregateBreakdown("postal", [row("a", 1), row("b", 2), row("c", 3)], "USD", { limit: 2 })!;
    expect(areas.map((a) => a.segment)).toEqual(["c", "b"]);
  });
  it("labels Demand Gen networks", () => {
    const n = aggregateBreakdown("network", [row("YOUTUBE", 5), row("GOOGLE_OWNED_CHANNELS", 3), row("GOOGLE_TV", 1)], "USD")!;
    expect(n.map((x) => x.label)).toEqual(["YouTube", "Discover and Gmail", "Google TV"]);
  });
});

describe("small helpers", () => {
  it("hour labels", () => {
    expect([0, 1, 11, 12, 13, 23].map(hourLabel)).toEqual(["12am", "1am", "11am", "12pm", "1pm", "11pm"]);
  });
  it("day of week from a report date", () => {
    expect(dayOfWeek("2026-11-19")).toBe(4); // Thursday
  });
  it("range start", () => {
    const ago = (d: number) => `ago${d}`;
    expect(rangeSince("7d", null, ago)).toBe("ago6");
    expect(rangeSince("30d", null, ago)).toBe("ago29");
    expect(rangeSince("all", new Date("2026-11-03T10:00:00Z"), ago)).toBe("2026-11-03");
  });
  it("days left at the current pace", () => {
    expect(daysLeftAtPace({ balanceMinor: 5_000, recentDailySpendMinor: [500, 500, 0], dailyBudgetMinor: 500 })).toBe(10);
    expect(daysLeftAtPace({ balanceMinor: 5_000, recentDailySpendMinor: [1_000, 400], dailyBudgetMinor: 500 })).toBe(7);
    expect(daysLeftAtPace({ balanceMinor: 5_000, recentDailySpendMinor: [], dailyBudgetMinor: 500 })).toBe(10);
    expect(daysLeftAtPace({ balanceMinor: 0, recentDailySpendMinor: [500], dailyBudgetMinor: 500 })).toBe(0);
    expect(daysLeftAtPace({ balanceMinor: null, recentDailySpendMinor: [500], dailyBudgetMinor: 500 })).toBeNull();
  });
  it("cost per click", () => {
    expect(costPerClick({ impressions: 0, views: 0, clicks: 8, costMicros: 10_000_000 }, "USD")).toEqual({ minor: 125, display: "$1.25" });
    expect(costPerClick({ impressions: 0, views: 0, clicks: 0, costMicros: 10_000_000 }, "USD")).toEqual({ minor: null, display: null });
  });
});

describe("assembleResults", () => {
  const t = new Date("2026-11-19T10:00:00Z");
  it("with no data: no totals, every breakdown null", () => {
    const r = assembleResults({
      range: "7d",
      since: "2026-11-13",
      currency: "USD",
      daily: [],
      segments: [],
      balanceMinor: 5_000,
      dailyBudgetMinor: 500,
      recentDailySpendMinor: [],
    });
    expect(r.totals).toBeNull();
    expect(Object.values(r.breakdowns).every((b) => b === null)).toBe(true);
    expect(r.balance).toEqual({ balanceMinor: 5_000, display: "$50", daysLeft: 10 });
    expect(r.lastSyncedAt).toBeNull();
  });
  it("$10 over 250 views and 8 clicks: 4¢ a view, $1.25 a click", () => {
    const r = assembleResults({
      range: "7d",
      since: "2026-11-13",
      currency: "USD",
      daily: [
        { date: "2026-11-15", impressions: 1_000, views: 150, clicks: 5, costMicros: 6_000_000, updatedAt: t },
        { date: "2026-11-16", impressions: 800, views: 100, clicks: 3, costMicros: 4_000_000, updatedAt: t },
      ],
      segments: [
        { dimension: "city", segment: "geoTargetConstants/1", label: "Brooklyn, New York", impressions: 9, views: 1, clicks: 0, costMicros: 0, updatedAt: t },
      ],
      balanceMinor: null,
      dailyBudgetMinor: 500,
      recentDailySpendMinor: [600, 400],
    });
    expect(r.totals).toMatchObject({ views: 250, clicks: 8, spendMinor: 1_000, costPerViewDisplay: "$0.04", costPerClickDisplay: "$1.25" });
    expect(r.trend.map((d) => d.views)).toEqual([150, 100]);
    expect(r.breakdowns.dayOfWeek!.map((d) => d.label)).toEqual(["Sunday", "Monday"]);
    // No ZIP rows: areas fall back to cities, with the stored place name.
    expect(r.breakdowns.location![0]!.label).toBe("Brooklyn, New York");
    expect(r.breakdowns.age).toBeNull();
    expect(r.balance).toBeNull();
  });
});

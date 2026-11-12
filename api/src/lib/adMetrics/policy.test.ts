import { describe, expect, it } from "vitest";
import {
  buildDailyMetricsQuery,
  clampRangeDays,
  DEFAULT_RANGE_DAYS,
  MAX_RANGE_DAYS,
  microsToMinor,
  parseDailyMetricsResults,
  rangeFor,
  sumCounts,
  summarise,
} from "./policy.js";

describe("buildDailyMetricsQuery", () => {
  it("selects the v22+ view field, never the removed video_views", () => {
    const q = buildDailyMetricsQuery("2026-11-01", "2026-11-08");
    expect(q).toContain("metrics.video_trueview_views");
    expect(q).not.toMatch(/metrics\.video_views\b/);
    expect(q).not.toContain("average_cpv");
    expect(q).toContain("FROM campaign");
    expect(q).toContain("segments.date BETWEEN '2026-11-01' AND '2026-11-08'");
  });

  it("refuses anything that is not a date (it is interpolated into GAQL)", () => {
    expect(() => buildDailyMetricsQuery("2026-11-01' OR 1=1 --", "2026-11-08")).toThrow();
  });
});

describe("parseDailyMetricsResults", () => {
  it("maps int64 strings and drops rows without a campaign or date", () => {
    const rows = parseDailyMetricsResults([
      {
        campaign: { resourceName: "customers/1/campaigns/2" },
        segments: { date: "2026-11-10" },
        metrics: { impressions: "1200", videoTrueviewViews: "300", clicks: "12", costMicros: "4560000" },
      },
      { campaign: { resourceName: "customers/1/campaigns/3" }, segments: {}, metrics: {} },
      { segments: { date: "2026-11-10" } },
    ]);
    expect(rows).toEqual([
      {
        campaignResourceName: "customers/1/campaigns/2",
        date: "2026-11-10",
        impressions: 1200,
        views: 300,
        clicks: 12,
        costMicros: 4_560_000,
      },
    ]);
  });

  it("treats missing metrics as zero", () => {
    const [row] = parseDailyMetricsResults([
      { campaign: { resourceName: "c" }, segments: { date: "2026-11-10" } },
    ]);
    expect(row).toMatchObject({ impressions: 0, views: 0, clicks: 0, costMicros: 0 });
  });

  it("tolerates an absent results array (Google omits it when empty)", () => {
    expect(parseDailyMetricsResults(undefined)).toEqual([]);
  });
});

describe("summarise", () => {
  it("computes spend, cost per view and rates from summed counts", () => {
    const totals = sumCounts([
      { impressions: 1000, views: 200, clicks: 10, costMicros: 6_000_000 },
      { impressions: 1000, views: 100, clicks: 30, costMicros: 3_000_000 },
    ]);
    const s = summarise(totals, "USD");
    expect(s.spendMinor).toBe(900);
    expect(s.spendDisplay).toBe("$9");
    // $9 / 300 views = 3¢ — from the SUMS, not the average of 3¢ and 3¢ per row.
    expect(s.costPerViewMinor).toBe(3);
    expect(s.costPerViewDisplay).toBe("$0.03");
    expect(s.ctr).toBeCloseTo(0.02);
    expect(s.viewRate).toBeCloseTo(0.15);
  });

  it("shows a sub-cent cost per view as <$0.01, never as free", () => {
    const s = summarise({ impressions: 5000, views: 1000, clicks: 0, costMicros: 4_990_000 }, "USD");
    expect(s.costPerViewMinor).toBe(0);
    expect(s.costPerViewDisplay).toBe("<$0.01");
  });

  it("returns null derived values when there is nothing to divide by", () => {
    const s = summarise({ impressions: 0, views: 0, clicks: 0, costMicros: 0 }, "INR");
    expect(s.costPerViewMinor).toBeNull();
    expect(s.costPerViewDisplay).toBeNull();
    expect(s.ctr).toBeNull();
    expect(s.viewRate).toBeNull();
    expect(s.spendDisplay).toBe("₹0");
  });
});

describe("microsToMinor", () => {
  it("is 1e4 micros per minor unit", () => {
    expect(microsToMinor(1_234_567)).toBe(123);
  });
});

describe("ranges", () => {
  it("clamps requested days", () => {
    expect(clampRangeDays(undefined)).toBe(DEFAULT_RANGE_DAYS);
    expect(clampRangeDays("0")).toBe(DEFAULT_RANGE_DAYS);
    expect(clampRangeDays("30")).toBe(30);
    expect(clampRangeDays(10_000)).toBe(MAX_RANGE_DAYS);
  });

  it("covers N days ending today, with tomorrow as a timezone allowance", () => {
    const now = new Date("2026-11-12T10:00:00Z");
    expect(rangeFor(7, now)).toEqual({ since: "2026-11-06", until: "2026-11-13" });
  });
});

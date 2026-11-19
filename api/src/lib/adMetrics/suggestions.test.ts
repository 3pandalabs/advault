import { describe, expect, it } from "vitest";
import { buildSuggestions, judgeSegment, perUnit } from "./suggestions.js";
import type { BreakdownItem } from "./segments.js";

const item = (segment: string, label: string, c: { impressions: number; clicks: number; spendMinor: number; views?: number }): BreakdownItem => ({
  segment,
  label,
  share: 0,
  impressions: c.impressions,
  views: c.views ?? 0,
  clicks: c.clicks,
  spendMinor: c.spendMinor,
  spendDisplay: "",
  costPerViewMinor: null,
  costPerViewDisplay: null,
  ctr: null,
  viewRate: null,
});

// Campaign: 1,000 shown, 40 clicks, $44 => $1.10 a click.
const totals = { impressions: 1_000, views: 300, clicks: 40, spendMinor: 4_400 };
// 35-44: 300 shown, 15 clicks, $9 => $0.60 a click (55% of average).
const age = [
  item("AGE_RANGE_35_44", "35–44", { impressions: 300, clicks: 15, spendMinor: 900 }),
  item("AGE_RANGE_25_34", "25–34", { impressions: 500, clicks: 20, spendMinor: 2_800 }),
  item("AGE_RANGE_UNDETERMINED", "Unknown", { impressions: 200, clicks: 5, spendMinor: 700 }),
];
const none = { age: null, gender: null, dayOfWeek: null, hour: null };
const base = {
  currency: "USD" as const,
  totals,
  breakdowns: none,
  housing: false,
  audienceFilters: null,
  adSchedule: null,
  dailyBudgetMinor: 500,
};

describe("judgeSegment", () => {
  it("needs a clear win with enough volume on both sides", () => {
    expect(judgeSegment({ impressions: 300, views: 0, clicks: 15, spendMinor: 900 }, totals)).toMatchObject({ metric: "click" });
    // Only 4 clicks in the segment.
    expect(judgeSegment({ impressions: 300, views: 0, clicks: 4, spendMinor: 200 }, totals)).toBeNull();
    // 99 times shown.
    expect(judgeSegment({ impressions: 99, views: 0, clicks: 10, spendMinor: 300 }, totals)).toBeNull();
    // Only 20% cheaper ($0.88 vs $1.10): not clear enough.
    expect(judgeSegment({ impressions: 300, views: 0, clicks: 10, spendMinor: 880 }, totals)).toBeNull();
    // Campaign too small to call an average (150 shown).
    expect(judgeSegment({ impressions: 100, views: 0, clicks: 5, spendMinor: 100 }, { ...totals, impressions: 150 })).toBeNull();
    // Already ~all of the spend.
    expect(judgeSegment({ impressions: 950, views: 0, clicks: 38, spendMinor: 4_000 }, totals)).toBeNull();
  });

  it("falls back to cost per view when clicks are too few", () => {
    const t = { impressions: 1_000, views: 200, clicks: 3, spendMinor: 1_000 }; // 5¢ a view
    expect(judgeSegment({ impressions: 300, views: 100, clicks: 1, spendMinor: 300 }, t)).toMatchObject({ metric: "view" });
    expect(judgeSegment({ impressions: 300, views: 19, clicks: 1, spendMinor: 50 }, t)).toBeNull();
  });
});

describe("buildSuggestions", () => {
  it("suggests the cheaper age band with the narrowing to apply and the reach warning", () => {
    const [s, ...rest] = buildSuggestions({ ...base, breakdowns: { ...none, age } });
    expect(rest).toHaveLength(0);
    expect(s).toMatchObject({
      id: "age:AGE_RANGE_35_44",
      message: "35–44 get you clicks at $0.60 vs $1.10 average.",
      question: "Focus on them?",
      apply: { audienceFilters: { ages: ["35-44", "unknown"] } },
      reachWarning: "At $5 a day, narrowing can make your ad show less. If views drop, widen it again.",
    });
  });

  it("keeps the campaign's other filters when narrowing", () => {
    const [s] = buildSuggestions({ ...base, breakdowns: { ...none, age }, audienceFilters: { languages: ["es"] } });
    expect(s!.apply).toEqual({ audienceFilters: { languages: ["es"], ages: ["35-44", "unknown"] } });
  });

  it("never suggests age or gender for real estate, nor a dimension already narrowed", () => {
    expect(buildSuggestions({ ...base, breakdowns: { ...none, age }, housing: true })).toEqual([]);
    expect(buildSuggestions({ ...base, breakdowns: { ...none, age }, audienceFilters: { ages: ["25-34"] } })).toEqual([]);
  });

  it("never suggests Unknown", () => {
    const onlyUnknownWins = [item("AGE_RANGE_UNDETERMINED", "Unknown", { impressions: 400, clicks: 30, spendMinor: 600 })];
    expect(buildSuggestions({ ...base, breakdowns: { ...none, age: onlyUnknownWins } })).toEqual([]);
  });

  it("tolerates empty breakdowns and no totals", () => {
    expect(buildSuggestions(base)).toEqual([]);
    expect(buildSuggestions({ ...base, totals: null, breakdowns: { ...none, age } })).toEqual([]);
  });

  it("weekends: a schedule for Sat + Sun, all day", () => {
    const dayOfWeek = [
      item("0", "Sunday", { impressions: 150, clicks: 8, spendMinor: 300 }),
      item("6", "Saturday", { impressions: 150, clicks: 8, spendMinor: 300 }),
      ...["1", "2", "3", "4", "5"].map((d) => item(d, "x", { impressions: 140, clicks: 5, spendMinor: 760 })),
    ];
    const [s] = buildSuggestions({ ...base, breakdowns: { ...none, dayOfWeek } });
    expect(s).toMatchObject({
      dimension: "dayOfWeek",
      message: "Weekends get you clicks at $0.38 vs $1.10 average.",
      question: "Show it on weekends only?",
      apply: { adSchedule: { days: ["sat", "sun"], startHour: 0, endHour: 24 } },
    });
  });

  it("hours: a block of the day, every day; none once a schedule is set", () => {
    const hour = Array.from({ length: 24 }, (_, h) =>
      h >= 12 && h < 18
        ? item(String(h), "", { impressions: 50, clicks: 3, spendMinor: 100 }) // 300 shown, 18 clicks, $6
        : item(String(h), "", { impressions: 39, clicks: 1, spendMinor: 211 }),
    );
    const [s] = buildSuggestions({ ...base, breakdowns: { ...none, hour } });
    expect(s).toMatchObject({
      dimension: "hour",
      apply: { adSchedule: { days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], startHour: 12, endHour: 18 } },
    });
    expect(
      buildSuggestions({ ...base, breakdowns: { ...none, hour }, adSchedule: { days: ["mon"], startHour: 0, endHour: 24 } }),
    ).toEqual([]);
  });

  it("at most two, best first", () => {
    const gender = [
      item("FEMALE", "Women", { impressions: 400, clicks: 20, spendMinor: 1_400 }), // $0.70
      item("MALE", "Men", { impressions: 600, clicks: 20, spendMinor: 3_000 }),
    ];
    const dayOfWeek = [
      item("0", "Sunday", { impressions: 150, clicks: 8, spendMinor: 300 }),
      item("6", "Saturday", { impressions: 150, clicks: 8, spendMinor: 300 }),
    ];
    const out = buildSuggestions({ ...base, breakdowns: { ...none, age, gender, dayOfWeek } });
    expect(out.map((s) => s.dimension)).toEqual(["dayOfWeek", "age"]);
  });
});

describe("perUnit", () => {
  it("never rounds a small cost to zero", () => {
    expect(perUnit(110, "USD")).toBe("$1.10");
    expect(perUnit(4, "USD")).toBe("$0.040");
    expect(perUnit(0.4, "USD")).toBe("$0.004");
  });
});

// Pricing, margin modes and currency.
//
// EVERY money value in this codebase is an integer in the currency's MINOR unit
// — paise for INR, cents for USD. Never a float. A float daily budget
// accumulates representation error into something charged to a real card, and
// Google's own API takes micros for the same reason. The only place a decimal
// appears is formatting for display.

export const CURRENCIES = ["INR", "USD"] as const;
export type Currency = (typeof CURRENCIES)[number];

export function isCurrency(v: string): v is Currency {
  return (CURRENCIES as readonly string[]).includes(v);
}

// Country → currency. Deliberately a tiny explicit map rather than a lookup
// library: these are the only two markets AdVault serves, and a wrong guess
// here would price someone in the wrong currency.
export function currencyForCountry(countryCode: string): Currency {
  return countryCode.toUpperCase() === "IN" ? "INR" : "USD";
}

export const MINOR_PER_MAJOR = 100;

// ---------------------------------------------------------------------------
// Margin modes.
//
// `standard` charges a platform fee on top of ad spend — the normal commercial
// mode. `at_cost` charges the raw Google spend and nothing else: a deliberate
// 0%-margin growth setting for early adopters and case studies. It is a real
// mode, not a discount code, so it lives in the data model rather than in a
// coupon table.
// ---------------------------------------------------------------------------

export const MARGIN_MODES = ["standard", "at_cost"] as const;
export type MarginMode = (typeof MARGIN_MODES)[number];

export type Plan = {
  key: string;
  currency: Currency;
  /** One-off charge to create the campaign and render its creatives. */
  creationFeeMinor: number;
  /** Recurring platform fee, 0 in at_cost mode. */
  monthlyFeeMinor: number;
  /** Suggested starting ad budget for the month. */
  suggestedAdBudgetMinor: number;
  /** Floor for a daily budget, below which Google delivery is not meaningful. */
  minDailyBudgetMinor: number;
  label: string;
  blurb: string;
};

// The starter tiers. Numbers are the ones the business decided; the point of
// keeping them here rather than in the UI is that the launch guard, the
// checkout and the calculator must all agree, and a copy in the frontend is a
// copy that will drift.
export const PLANS: Record<string, Plan> = {
  "in-starter": {
    key: "in-starter",
    currency: "INR",
    creationFeeMinor: 299_900, // ₹2,999
    monthlyFeeMinor: 0,
    suggestedAdBudgetMinor: 200_000, // ₹2,000
    minDailyBudgetMinor: 10_000, // ₹100/day
    label: "India Starter",
    blurb: "Reach your neighbourhood on YouTube from ₹2,000 of ad spend a month.",
  },
  "in-starter-at-cost": {
    key: "in-starter-at-cost",
    currency: "INR",
    creationFeeMinor: 0,
    monthlyFeeMinor: 0,
    // ~₹2,085: the raw pass-through figure the business quotes for this tier.
    suggestedAdBudgetMinor: 208_500,
    minDailyBudgetMinor: 10_000,
    label: "India Starter — at cost",
    blurb: "You pay exactly what Google charges. No platform fee.",
  },
  "us-starter": {
    key: "us-starter",
    currency: "USD",
    creationFeeMinor: 2_900, // $29
    monthlyFeeMinor: 0,
    suggestedAdBudgetMinor: 10_000, // $100
    minDailyBudgetMinor: 500, // $5/day
    label: "US Starter",
    blurb: "Reach your neighbourhood on YouTube from $100 of ad spend a month.",
  },
  "us-starter-at-cost": {
    key: "us-starter-at-cost",
    currency: "USD",
    creationFeeMinor: 0,
    monthlyFeeMinor: 0,
    suggestedAdBudgetMinor: 10_100, // ~$101 raw
    minDailyBudgetMinor: 500,
    label: "US Starter — at cost",
    blurb: "You pay exactly what Google charges. No platform fee.",
  },
};

export function planFor(currency: Currency, mode: MarginMode): Plan {
  const prefix = currency === "INR" ? "in-starter" : "us-starter";
  return PLANS[mode === "at_cost" ? `${prefix}-at-cost` : prefix];
}

// ---------------------------------------------------------------------------
// The reach estimate behind the landing page calculator.
//
// This is a MODELLED estimate, not a promise, and the UI must say so. It is
// derived from representative YouTube CPM ranges for local geo-targeted video —
// the same honesty constraint MealMargin's dataset carries. Quoting a hard
// number for someone's specific neighbourhood would be a claim we cannot back.
// ---------------------------------------------------------------------------

// Cost per thousand impressions, in minor units. Local video reach campaigns
// sit well below national CPMs because the audience is small and cheap.
const CPM_MINOR: Record<Currency, { low: number; high: number }> = {
  INR: { low: 8_000, high: 15_000 }, // ₹80–₹150 CPM
  USD: { low: 300, high: 600 }, // $3–$6 CPM
};

export type ReachEstimate = { low: number; high: number; currency: Currency };

/** Impressions a given ad budget plausibly buys. Rounded to avoid false precision. */
export function estimateReach(adBudgetMinor: number, currency: Currency): ReachEstimate {
  const cpm = CPM_MINOR[currency];
  const round = (n: number) => Math.round(n / 500) * 500;
  return {
    // High CPM buys FEWER impressions — the low bound of reach.
    low: round((adBudgetMinor / cpm.high) * 1000),
    high: round((adBudgetMinor / cpm.low) * 1000),
    currency,
  };
}

/** What the advertiser pays us up front to start: creation fee + first ad budget. */
export function upfrontTotalMinor(plan: Plan, adBudgetMinor: number): number {
  return plan.creationFeeMinor + plan.monthlyFeeMinor + adBudgetMinor;
}

export function formatMinor(minor: number, currency: Currency): string {
  return new Intl.NumberFormat(currency === "INR" ? "en-IN" : "en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: minor % MINOR_PER_MAJOR === 0 ? 0 : 2,
  }).format(minor / MINOR_PER_MAJOR);
}

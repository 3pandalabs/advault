// Pricing, product lines, margin modes and currency.
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
// Product lines.
//
// `offer` is the monthly offer subscription: we produce fresh creatives for
// this month's promotion and nothing touches Google Ads. It exists because it
// is the ONLY thing AdVault can sell without a Google developer token, a
// YouTube upload path, or an Indian entity — every one of which is a
// prerequisite the managed line cannot start earning without.
//
// `managed` is the full product: creatives plus a live, geo-targeted Google Ads
// campaign.
//
// This is orthogonal to `ad_accounts.billing_mode`, which answers a different
// question (whose card Google charges). A managed subscriber can be platform-
// or customer-billed; an offer subscriber has no ad account at all.
// ---------------------------------------------------------------------------

export const PRODUCT_LINES = ["offer", "managed"] as const;
export type ProductLine = (typeof PRODUCT_LINES)[number];

// ---------------------------------------------------------------------------
// Margin modes.
//
// `standard` charges the platform fee. `at_cost` waives it entirely: a
// deliberate 0%-margin growth setting for early adopters and case studies.
//
// It used to be modelled as a second set of plan rows ("in-starter-at-cost").
// It is now a MODIFIER on any plan, because duplicating the plan table meant
// every new SKU silently needed a twin, and the two copies drifted the moment
// a price changed. One price list, one waiver flag.
// ---------------------------------------------------------------------------

export const MARGIN_MODES = ["standard", "at_cost"] as const;
export type MarginMode = (typeof MARGIN_MODES)[number];

export type Plan = {
  key: string;
  currency: Currency;
  line: ProductLine;
  /**
   * The recurring platform fee. This is the entire revenue model — there is no
   * one-off charge any more. A plan with monthlyFeeMinor 0 earns nothing, which
   * is exactly what every plan did before this file was rewritten.
   */
  monthlyFeeMinor: number;
  /** Fresh creatives produced per billing period. */
  includedCreativesPerMonth: number;
  /**
   * Suggested monthly ad budget. 0 on the offer line, which buys no media —
   * a non-zero value there would quote the advertiser for something we do not
   * supply.
   */
  suggestedAdBudgetMinor: number;
  /** Floor for a daily budget, below which Google delivery is not meaningful. */
  minDailyBudgetMinor: number;
  label: string;
  blurb: string;
};

// The four SKUs. Numbers are the ones the business decided; the point of
// keeping them here rather than in the UI is that the launch guard, the
// checkout, the subscription charger and the calculator must all agree, and a
// copy in the frontend is a copy that will drift.
export const PLANS: Record<string, Plan> = {
  "in-offer": {
    key: "in-offer",
    currency: "INR",
    line: "offer",
    monthlyFeeMinor: 99_900, // ₹999/month
    includedCreativesPerMonth: 3,
    suggestedAdBudgetMinor: 0,
    minDailyBudgetMinor: 0,
    label: "India — Monthly Offer",
    blurb: "Three fresh videos a month for whatever you're promoting. No ad spend.",
  },
  "in-managed": {
    key: "in-managed",
    currency: "INR",
    line: "managed",
    monthlyFeeMinor: 149_900, // ₹1,499/month platform fee
    includedCreativesPerMonth: 2,
    suggestedAdBudgetMinor: 200_000, // ₹2,000
    minDailyBudgetMinor: 10_000, // ₹100/day
    label: "India — Managed Ads",
    blurb: "Your offer running on YouTube around your shop, handled end to end.",
  },
  "us-offer": {
    key: "us-offer",
    currency: "USD",
    line: "offer",
    monthlyFeeMinor: 3_900, // $39/month
    includedCreativesPerMonth: 3,
    suggestedAdBudgetMinor: 0,
    minDailyBudgetMinor: 0,
    label: "US — Monthly Offer",
    blurb: "Three fresh videos a month for whatever you're promoting. No ad spend.",
  },
  "us-managed": {
    key: "us-managed",
    currency: "USD",
    line: "managed",
    monthlyFeeMinor: 7_900, // $79/month platform fee
    includedCreativesPerMonth: 2,
    suggestedAdBudgetMinor: 10_000, // $100
    minDailyBudgetMinor: 500, // $5/day
    label: "US — Managed Ads",
    blurb: "Your offer running on YouTube around your business, handled end to end.",
  },
};

export function planFor(currency: Currency, line: ProductLine): Plan {
  return PLANS[`${currency === "INR" ? "in" : "us"}-${line}`];
}

export function planByKey(key: string): Plan | null {
  return PLANS[key] ?? null;
}

/** The fee actually charged, after the at-cost waiver. */
export function effectiveMonthlyFeeMinor(plan: Plan, mode: MarginMode): number {
  return mode === "at_cost" ? 0 : plan.monthlyFeeMinor;
}

/**
 * What the advertiser is quoted as an all-in monthly price.
 *
 * Platform-billed managed accounts see ONE number — fee plus the ad budget we
 * front on their behalf (₹1,499 + ₹2,000 = ₹3,499). Customer-billed accounts
 * see the fee alone, because their own card pays Google directly and we never
 * touch the media money.
 *
 * Caveat worth knowing before repricing: ₹1,499 of fee on ₹2,000 of spend is a
 * 75% fee ratio against an agency norm of 15–20%. It survives only when quoted
 * as an all-in product price, never as "spend plus management fee". Raising the
 * bundled budget to ₹3,000 at a ₹4,499 sticker halves the ratio for the same
 * revenue, and is the change to make if the split ever becomes visible to
 * customers.
 */
export function monthlyQuoteMinor(
  plan: Plan,
  opts: { marginMode?: MarginMode; bundledAdBudgetMinor?: number } = {},
): number {
  const fee = effectiveMonthlyFeeMinor(plan, opts.marginMode ?? "standard");
  return fee + (opts.bundledAdBudgetMinor ?? 0);
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

export function formatMinor(minor: number, currency: Currency): string {
  return new Intl.NumberFormat(currency === "INR" ? "en-IN" : "en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: minor % MINOR_PER_MAJOR === 0 ? 0 : 2,
  }).format(minor / MINOR_PER_MAJOR);
}

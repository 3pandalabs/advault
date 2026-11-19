// The customer-facing prices, in one place (USD cents). Mirrored from the API:
// api/src/lib/pricing (us-new_ad $10, us-website $10, us-evergreen $20/month,
// the plan's automatic recharge of the customer's chosen monthly ad budget,
// min $35, MIN_MONTHLY_AD_BUDGET_MINOR). Change the API first, then here.
// Home-page prose may keep its own wording.
//
// "From $55 a month" (owner, 2026-11-19): month one = ad $10 + website $10 +
// plan $0 (first month included) + the chosen ad budget; every month after =
// plan $20 + the SAME chosen budget ($35 -> $55, $100 -> $120). Or "Just this
// once": the same first payment, no plan, no renewals. The website (SiteVault
// Pro) stays included while the plan runs (a year of Pro on Just this once).

/** Making one ad from photos. One-time, per ad. */
export const AD_PRICE_CENTS = 1_000;

/** An ad from the customer's own uploaded video: we did not make it, so no fee. */
export const OWN_VIDEO_AD_PRICE_CENTS = 0;

/** "Make me a website": once; Pro stays included while the AdVault plan runs. */
export const WEBSITE_PRICE_CENTS = 1_000;

/** The AdVault plan, charged only for months an ad is running. First month included with the first ad. */
export const PLAN_PRICE_CENTS_PER_MONTH = 2_000;

/**
 * The smallest (and default) monthly ad budget. The customer chooses it,
 * whole dollars; the plan recharges the SAME amount each month (100% to
 * Google) and it can be changed anytime (PUT /subscription/ad-budget).
 */
export const MONTHLY_AD_BUDGET_CENTS = 3_500;

/** "Renews at $X/month from <date>": the plan + the chosen monthly budget. */
export function monthlyTotalCents(adBudgetCents: number): number {
  return PLAN_PRICE_CENTS_PER_MONTH + Math.max(adBudgetCents, MONTHLY_AD_BUDGET_CENTS);
}

/** One month from today, for the renewal line (the API stores the exact date). */
export function oneMonthFromToday(now = new Date()): Date {
  const d = new Date(now);
  d.setMonth(d.getMonth() + 1);
  return d;
}

/** The smallest ad budget top-up (also lib/budget TOPUP_PRESETS_CENTS[0]). */
export const MIN_AD_BUDGET_CENTS = 3_500;

export type CostInputs = {
  adBudgetCents: number;
  ownVideo: boolean;
  website: boolean;
  /** False once the account has used its included first month. */
  firstMonthIncluded: boolean;
};

export type CostBreakdown = {
  adCents: number;
  adBudgetCents: number;
  websiteCents: number;
  planTodayCents: number;
  totalTodayCents: number;
};

/** What the customer pays today for one ad. Pure, so every screen adds it up the same way. */
export function costToday(i: CostInputs): CostBreakdown {
  const adCents = i.ownVideo ? OWN_VIDEO_AD_PRICE_CENTS : AD_PRICE_CENTS;
  const websiteCents = i.website ? WEBSITE_PRICE_CENTS : 0;
  const planTodayCents = i.firstMonthIncluded ? 0 : PLAN_PRICE_CENTS_PER_MONTH;
  const adBudgetCents = Math.max(i.adBudgetCents, 0);
  return {
    adCents,
    adBudgetCents,
    websiteCents,
    planTodayCents,
    totalTodayCents: adCents + adBudgetCents + websiteCents + planTodayCents,
  };
}

export type MonthlyBreakdown = {
  /** Month one: what is paid when the first ad starts. */
  firstMonth: CostBreakdown;
  /** Every month after, while the ad runs: the plan + the ad-budget recharge. */
  everyMonth: { planCents: number; adBudgetCents: number; totalCents: number };
};

/**
 * Month one vs every month after (default: $10 + $10 + $0 + $35 = $55, then
 * $20 + $35 = $55). `adBudgetCents` is the monthly ad budget; the recharge
 * after month one is the same amount.
 */
export function monthlyBreakdown(i: CostInputs): MonthlyBreakdown {
  const firstMonth = costToday(i);
  const adBudgetCents = Math.max(i.adBudgetCents, 0);
  return {
    firstMonth,
    everyMonth: {
      planCents: PLAN_PRICE_CENTS_PER_MONTH,
      adBudgetCents,
      totalCents: PLAN_PRICE_CENTS_PER_MONTH + adBudgetCents,
    },
  };
}

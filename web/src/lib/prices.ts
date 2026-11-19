// The customer-facing prices, in one place (USD cents). Mirrored from the API:
// api/src/lib/pricing (us-new_ad $10, us-website $10, us-evergreen $20/month,
// the plan's automatic $35 monthly ad-budget recharge, suggestedAdBudgetMinor
// $35). Change the API first, then here. Home-page prose may keep its own
// wording.
//
// "$55 a month" (owner, 2026-11-19): month one = ad $10 + website $10 + plan
// $0 (first month included) + ad budget $35; every month after = plan $20 +
// ad budget $35. The website (SiteVault Pro) stays included while the plan
// runs, so there is no separate renewal any more.

/** Making one ad from photos. One-time, per ad. */
export const AD_PRICE_CENTS = 1_000;

/** An ad from the customer's own uploaded video: we did not make it, so no fee. */
export const OWN_VIDEO_AD_PRICE_CENTS = 0;

/** "Make me a website": once; Pro stays included while the AdVault plan runs. */
export const WEBSITE_PRICE_CENTS = 1_000;

/** The AdVault plan, charged only for months an ad is running. First month included with the first ad. */
export const PLAN_PRICE_CENTS_PER_MONTH = 2_000;

/** The ad budget the plan recharges automatically each month (100% to Google). */
export const MONTHLY_AD_BUDGET_CENTS = 3_500;

/** Wallet page and campaign ad-budget card: the automatic monthly recharge. */
export const MONTHLY_RECHARGE_LINE = `While your AdVault plan runs, $${MONTHLY_AD_BUDGET_CENTS / 100} is added to your ad budget automatically each month, charged with the $${PLAN_PRICE_CENTS_PER_MONTH / 100} plan fee. 100% of it goes to Google.`;

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

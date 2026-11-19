// The customer-facing prices, in one place (USD cents). Mirrored from the API:
// api/src/lib/pricing (us-new_ad $10, us-website $10, us-evergreen $19/month,
// suggestedAdBudgetMinor $35) and the SiteVault Pro renewal ($49/year). Change
// the API first, then here. Home-page prose may keep its own wording.

/** Making one ad from photos. One-time, per ad. */
export const AD_PRICE_CENTS = 1_000;

/** An ad from the customer's own uploaded video: we did not make it, so no fee. */
export const OWN_VIDEO_AD_PRICE_CENTS = 0;

/** "Make me a website": first year of SiteVault Pro included. */
export const WEBSITE_PRICE_CENTS = 1_000;

/** SiteVault Pro after the included first year. */
export const WEBSITE_RENEWAL_CENTS_PER_YEAR = 4_900;

/** The AdVault plan, charged only for months an ad is running. First month included with the first ad. */
export const PLAN_PRICE_CENTS_PER_MONTH = 1_900;

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

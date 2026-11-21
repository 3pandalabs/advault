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
// `evergreen` ("Keep it running", US only, added 2026-11-11) is for the shop
// that wants ONE ad kept on air, not a new offer every month: a low monthly fee
// plus their ad budget, no monthly offer messages, and no offer expiry, so the
// campaign runs until they stop it. Each ad made for it is a separate one-off
// charge (the new-ad purchase), not part of the fee.
//
// This is orthogonal to `ad_accounts.billing_mode`, which answers a different
// question (whose card Google charges). A managed subscriber can be platform-
// or customer-billed; an offer subscriber has no ad account at all.
// ---------------------------------------------------------------------------

export const PRODUCT_LINES = ["offer", "managed", "evergreen"] as const;
export type ProductLine = (typeof PRODUCT_LINES)[number];

/**
 * Does this line run the ORIGINAL monthly offer loop (offer text re-renders
 * the creatives and an expiry PAUSES the campaign)? Evergreen does not: its
 * promise is that the ad keeps running. Since 2026-11-21 evergreen gets offer
 * CHANGES instead (hasOfferChanges): a re-cut swapped into the live ad, and
 * back to the base ad on the end date, never a pause.
 */
export function hasMonthlyOffers(line: ProductLine): boolean {
  return line === "offer" || line === "managed";
}

/**
 * Does this line get "Change my offer" with its monthly included change and
 * the WhatsApp offer-change loop (lib/offerSwap)? Evergreen ("Keep it
 * running") only. Anyone else with a launched campaign may still change the
 * offer, at OFFER_CHANGE_PRICE each.
 */
export function hasOfferChanges(line: ProductLine): boolean {
  return line === "evergreen";
}

/** Offer changes included per calendar month (UTC) on a hasOfferChanges plan. */
export const OFFER_CHANGES_INCLUDED_PER_MONTH = 1;

/** Does this line buy media, i.e. carry an ad budget and a live campaign? */
export function buysMedia(line: ProductLine): boolean {
  return line !== "offer";
}

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
    // $5/day: Google's per-day minimum for a Demand Gen campaign budget in USD.
    // It was lowered to $1 on 2026-11-10 and Google refused it
    // (BUDGET_BELOW_PER_DAY_MINIMUM, budgetPerDayMinimumMicros 5000000), found
    // by a validateOnly dry run on 2026-11-19. Do not go below it again.
    minDailyBudgetMinor: 500, // $5/day
    label: "US — Managed Ads",
    blurb: "Your offer running on YouTube around your business, handled end to end.",
  },
  "us-evergreen": {
    key: "us-evergreen",
    currency: "USD",
    line: "evergreen",
    // $20/month platform fee ("$55 a month", owner decision 2026-11-19; $19
    // until then, never sold to a real customer, so nobody is grandfathered).
    monthlyFeeMinor: 2_000,
    // Ads are bought one at a time ($10 each), never bundled into the fee.
    includedCreativesPerMonth: 0,
    // $35 = one week at Google's $5/day Demand Gen minimum (was $30, sized
    // for the old $1/day floor, which then covered only 6 days).
    suggestedAdBudgetMinor: 3_500,
    minDailyBudgetMinor: 500, // $5/day, Google's Demand Gen minimum (see us-managed)
    label: "US — Keep it running",
    blurb: "One ad kept running on YouTube around your business. $10 per ad, one offer change a month included.",
  },
};

/**
 * "From $55 a month" (2026-11-19): every PAID month of a Keep it running plan
 * also charges the customer's CHOSEN monthly ad budget, credited to their ad
 * budget wallet (100% goes to Google). The customer picks it (whole dollars,
 * at least $35) at checkout and can change it anytime from the next invoice
 * (`PUT /subscription/ad-budget`). $35 = about 6 days at Google's $5/day
 * minimum, spread across the month by the ad schedule (lib/schedule/spread.ts).
 * Not in the included first month: that month's budget is the customer's
 * first top-up. US only, like the plan.
 */
export const MIN_MONTHLY_AD_BUDGET_MINOR: Partial<Record<Currency, number>> = { USD: 3_500 };
/** Upper bound on a chosen monthly ad budget: a typo guard, not a product limit. */
export const MAX_MONTHLY_AD_BUDGET_MINOR = 1_000_000;
/** Stripe charges the budget as quantity x a $1 unit price. */
export const MONTHLY_AD_BUDGET_UNIT_MINOR = 100;

/**
 * Why a chosen monthly ad budget is not allowed, or null when it is: at
 * least the currency's minimum ($35), whole dollars, under the typo guard.
 * A currency with no recharge (no minimum set) allows none.
 */
export function monthlyAdBudgetProblem(
  amountMinor: number,
  currency: Currency,
): null | { error: "budget_below_minimum" | "budget_not_whole_dollars" | "budget_too_large" | "no_monthly_budget"; minMinor: number } {
  const minMinor = MIN_MONTHLY_AD_BUDGET_MINOR[currency] ?? 0;
  if (minMinor <= 0) return { error: "no_monthly_budget", minMinor };
  if (!Number.isInteger(amountMinor) || amountMinor < minMinor) return { error: "budget_below_minimum", minMinor };
  if (amountMinor % MONTHLY_AD_BUDGET_UNIT_MINOR !== 0) return { error: "budget_not_whole_dollars", minMinor };
  if (amountMinor > MAX_MONTHLY_AD_BUDGET_MINOR) return { error: "budget_too_large", minMinor };
  return null;
}

/**
 * The lowest daily budget a campaign in this currency may have: the highest
 * floor among the plans that buy media in it (USD $5 = Google's Demand Gen
 * per-day minimum; INR ₹100). A currency no plan sells has no floor here.
 * Used by campaign create/edit and re-checked at launch.
 */
export function minDailyBudgetMinorFor(currency: string): number {
  let min = 0;
  for (const p of Object.values(PLANS)) {
    if (p.currency === currency && buysMedia(p.line)) min = Math.max(min, p.minDailyBudgetMinor);
  }
  return min;
}

/**
 * Null when the budget meets its currency's floor, else what to tell the
 * advertiser. The one rule behind campaign create/edit and the launch
 * pre-check, so all three say the same thing.
 */
export function budgetBelowMinimum(dailyBudgetMinor: number, currency: string): BudgetMinimumBody | null {
  const min = minDailyBudgetMinorFor(currency);
  return dailyBudgetMinor >= min ? null : budgetMinimumBody(min, currency);
}

/**
 * How long an ad runs: 7 or 14 days, or null = always on (no end date). The
 * wizard's "How long should your ad run?" (campaigns.run_days, migration 0033).
 * Mirrored in web/src/lib/budget.ts.
 */
export const RUN_DAYS = [7, 14] as const;
export type RunDays = (typeof RUN_DAYS)[number] | null;

/** Average days in a month, for the "always on" monthly estimate. */
export const DAYS_PER_MONTH = 30.4;

/**
 * Total ad spend for a run: daily x 7 / x 14, or for always on about one
 * month (daily x 30.4, rounded to the minor unit).
 */
export function adSpendTotalMinor(dailyBudgetMinor: number, runDays: RunDays): number {
  return Math.round(dailyBudgetMinor * (runDays ?? DAYS_PER_MONTH));
}

/**
 * The last serving day for a run that starts on `startDate` (YYYY-MM-DD):
 * start + runDays - 1, so a 7-day run serves 7 calendar days. Null for
 * always on. Google reads it in the ACCOUNT's time zone; launch passes the
 * UTC date, which is the same day or one day after the date in any US time
 * zone, so a run is never cut short (at most a day long).
 */
export function runEndDate(startDate: string, runDays: RunDays): string | null {
  if (runDays == null) return null;
  const d = new Date(`${startDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`bad start date: ${startDate}`);
  d.setUTCDate(d.getUTCDate() + runDays - 1);
  return d.toISOString().slice(0, 10);
}

/** The 409/400 body for a budget under the floor (also used for Google's own refusal). */
export type BudgetMinimumBody = {
  error: "budget_below_minimum";
  minDailyBudgetMinor: number;
  currencyCode: string;
  detail: string;
};

export function budgetMinimumBody(minDailyBudgetMinor: number, currency: string): BudgetMinimumBody {
  const symbol = currency === "USD" ? "$" : currency === "INR" ? "₹" : `${currency} `;
  const amount = `${symbol}${(minDailyBudgetMinor / MINOR_PER_MAJOR).toLocaleString("en-US")}`;
  return {
    error: "budget_below_minimum",
    minDailyBudgetMinor,
    currencyCode: currency,
    detail: `Google needs at least ${amount} a day for this kind of ad. Raise your daily budget to launch.`,
  };
}

// Only the lines sold in every market: evergreen is US-only, so it is looked
// up by key (planByKey) rather than through here.
export function planFor(currency: Currency, line: "offer" | "managed"): Plan {
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

// ---------------------------------------------------------------------------
// One-off add-ons.
//
// The subscription is still the revenue model — see CLAUDE.md — and this does
// not change that. An add-on is a SINGLE purchase that produces one artefact,
// billed once, and it exists because of a gap the subscriptions cannot close:
//
// Everything the monthly plans produce, a shop owner could plausibly make on
// their own phone. Copy, captions, a slow zoom on a photo, even an
// image-to-video clip — CapCut and Kling's own consumer app do all of it free.
// Selling that is selling a commodity. The `cinematic` add-on is deliberately
// the opposite: TEXT-to-video, where the model invents the scene and therefore
// controls the lighting, lens and composition. That is the part a phone cannot
// reach at any effort, and it is the only reason the price below stands up.
//
// It is priced against a videographer (₹15,000–50,000 for a half-day) and a
// freelance editor (₹3,000–15,000), NOT against other software. First purchase
// is heavily discounted because the entire job of the first one is to be tried.
// ---------------------------------------------------------------------------

// `new_ad` (2026-11-11; $10 from 2026-11-12) is the $10 ad for Keep it running subscribers: that
// plan bundles no creatives, so every ad it runs, the first included, is one of
// these. Same price first and repeat; it is not an intro offer.
// VIDEO BUNDLE = the `cinematic` + `cinematic_pack` SKUs (renamed for people
// 2026-11-15; identifiers unchanged). SALES PAUSED, see routes/cinematic.ts.
// `cinematic_pack` (2026-11-14): three cinematic ads paid up front. It is never
// produced itself; it grants credits that later cinematic orders spend
// (lib/cinematic: packCreditsLeft). US only.
// `website` (2026-11-15): the $10 SiteVault website from "Make me a website",
// first year of Pro included (lib/websiteFee). US only.
export const ADD_ON_SKUS = ["cinematic", "new_ad", "cinematic_pack", "website", "offer_change"] as const;
export type AddOnSku = (typeof ADD_ON_SKUS)[number];

export type AddOn = {
  key: string;
  sku: AddOnSku;
  currency: Currency;
  /** Charged once, per artefact produced. */
  priceMinor: number;
  /**
   * What the advertiser pays for their FIRST one, ever. Not a coupon and not
   * time-limited — it is the price of finding out whether the thing is any
   * good, and it is checked against purchase history rather than a promo code
   * so it cannot be farmed.
   */
  firstPurchasePriceMinor: number;
  /**
   * Seconds of GENERATED footage. The real-photo close is extra and free —
   * it is the advertiser's own asset and costs nothing to encode.
   *
   * This is the cost driver and the reason the number lives in the price list:
   * text-to-video is metered per second, so a change here is a change to
   * margin, and it must not be settable from a request body.
   */
  generatedSeconds: number;
  /** Cinematic ads a pack grants (cinematic_pack only). */
  credits?: number;
  label: string;
  blurb: string;
};

export const ADD_ONS: Record<string, AddOn> = {
  "in-cinematic": {
    key: "in-cinematic",
    sku: "cinematic",
    currency: "INR",
    priceMinor: 299_900, // ₹2,999
    firstPurchasePriceMinor: 99_900, // ₹999
    generatedSeconds: 15,
    label: "India — Video bundle ad",
    blurb: "A filmed-looking ad built from a description, closing on your own photo.",
  },
  "us-cinematic": {
    key: "us-cinematic",
    sku: "cinematic",
    currency: "USD",
    priceMinor: 3_900, // $39 (was $99 until 2026-11-14)
    firstPurchasePriceMinor: 2_900, // $29
    generatedSeconds: 15,
    label: "US — Video bundle ad",
    blurb: "A filmed-looking ad built from a description, closing on your own photo.",
  },
  "us-cinematic_pack": {
    key: "us-cinematic_pack",
    sku: "cinematic_pack",
    currency: "USD",
    priceMinor: 9_900, // $99 for three ($33 each)
    firstPurchasePriceMinor: 9_900, // same price first time
    generatedSeconds: 0, // the pack films nothing; each credit's order does
    credits: 3,
    label: "US — Video bundle 3-pack",
    blurb: "Three cinematic ads, paid up front.",
  },
  "us-new_ad": {
    key: "us-new_ad",
    sku: "new_ad",
    currency: "USD",
    priceMinor: 1_000, // $10 (was $19 until 2026-11-12)
    firstPurchasePriceMinor: 1_000, // $10, the first ad too
    generatedSeconds: 0, // the standard photo pipeline; nothing text-to-video
    label: "US — New ad",
    blurb: "A new ad from your photos, for the Keep it running plan.",
  },
  // "Change my offer" (2026-11-21, lib/offerSwap): a cheap re-cut of the live
  // ad with the new offer, swapped in at Google. The Keep it running plan
  // includes one a month (OFFER_CHANGES_INCLUDED_PER_MONTH); every other
  // change is this. Admins / at_cost free; test mode 50 cents (chargeMinor).
  "us-offer_change": {
    key: "us-offer_change",
    sku: "offer_change",
    currency: "USD",
    priceMinor: 200, // $2
    firstPurchasePriceMinor: 200, // no intro price: the first one a month is included instead
    generatedSeconds: 0, // re-uses the launched ad's clips; nothing text-to-video
    label: "US — Offer change",
    blurb: "Your live ad with a new offer, swapped in at Google.",
  },
  "us-website": {
    key: "us-website",
    sku: "website",
    currency: "USD",
    priceMinor: 1_000, // $10; Pro included while the AdVault plan runs (lib/sitePlanCover), else a year of Pro then $49/yr on SiteVault
    firstPurchasePriceMinor: 1_000,
    generatedSeconds: 0,
    label: "US — Your website",
    blurb: "A one-page SiteVault website for your business, first year of Pro included.",
  },
};

// ---------------------------------------------------------------------------
// Offer combo (2026-11-15): "Also put this offer on my website". A $10 new ad
// plus the same offer on the business's SiteVault site is $12: this add-on is
// the $2, a second line item on the new ad's checkout. It is never charged
// when the site has a SiteVault credit to spend (the customer pays $10), when
// SiteVault billing is off, or for admins / at_cost accounts. US only, like
// new_ad. Rules: lib/siteOffer/policy.ts.
// ---------------------------------------------------------------------------

export const SITE_OFFER_ADDON: Partial<Record<Currency, { priceMinor: number; label: string }>> = {
  USD: { priceMinor: 200, label: "Offer on your website" }, // $2
};

// ---------------------------------------------------------------------------
// Launch offer (2026-11-12): the first ad is free for the first 30 Keep it
// running customers. Counted from free ads actually claimed, never from
// orders opened, so an abandoned order cannot use up a place. Two people
// claiming the last place at the same instant can take it to 31; that errs in
// the customer's favour and is not worth a lock.
// ---------------------------------------------------------------------------

// Dropped 2026-11-13: every ad is paid. Kept as a number so the offer can come
// back without code; 0 means no free ads.
export const FREE_FIRST_AD_LIMIT = 0;

export function freeFirstAd(args: { priorAdsClaimed: number; freeAdsClaimedByAnyone: number }): boolean {
  return args.priorAdsClaimed === 0 && args.freeAdsClaimedByAnyone < FREE_FIRST_AD_LIMIT;
}

export function freeFirstAdPlacesLeft(freeAdsClaimedByAnyone: number): number {
  return Math.max(0, FREE_FIRST_AD_LIMIT - freeAdsClaimedByAnyone);
}

export function addOnFor(currency: Currency, sku: AddOnSku): AddOn {
  return ADD_ONS[`${currency === "INR" ? "in" : "us"}-${sku}`];
}

/** Like addOnFor, but null where the SKU is not sold in that currency (the pack in India). */
export function maybeAddOnFor(currency: Currency, sku: AddOnSku): AddOn | null {
  return ADD_ONS[`${currency === "INR" ? "in" : "us"}-${sku}`] ?? null;
}

export function addOnByKey(key: string): AddOn | null {
  return ADD_ONS[key] ?? null;
}

/**
 * What this advertiser pays right now.
 *
 * Takes the count of add-ons they have already PAID for rather than a boolean,
 * so the caller cannot accidentally pass "has an order" (which would include
 * an abandoned checkout and hand the intro price away for free) — and so the
 * at-cost waiver still composes the same way it does for subscriptions.
 */
export function addOnPriceMinor(
  addOn: AddOn,
  opts: { priorPaidCount: number; marginMode?: MarginMode },
): number {
  if ((opts.marginMode ?? "standard") === "at_cost") return 0;
  return opts.priorPaidCount === 0 ? addOn.firstPurchasePriceMinor : addOn.priceMinor;
}

export function formatMinor(minor: number, currency: Currency): string {
  return new Intl.NumberFormat(currency === "INR" ? "en-IN" : "en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: minor % MINOR_PER_MAJOR === 0 ? 0 : 2,
  }).format(minor / MINOR_PER_MAJOR);
}

// ---------------------------------------------------------------------------
// Admin "Test as customer" (2026-11-17, lib/testMode). While an admin has it
// on, EVERY Stripe charge AdVault makes for them (the $10 ad, the website, the
// offer combo's $2, the video bundle, the monthly plan) is this amount: 50
// cents, Stripe's minimum charge in USD. The purchase/invoice row records it,
// so the webhook's amount check reconciles. Ad budget top-ups are NOT test
// priced: that money really goes to Google.
// ---------------------------------------------------------------------------

export const TEST_PRICE_MINOR = 50;

/** The amount to charge: the test price in test mode, else the real one. A $0 waiver stays $0. */
export function chargeMinor(realMinor: number, testMode: boolean): number {
  return testMode && realMinor > 0 ? TEST_PRICE_MINOR : realMinor;
}

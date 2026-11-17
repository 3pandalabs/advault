// Offer combo: pure decisions. No database, no fetch (see index.ts beside it).
//
// The product rule (2026-11-15): an AdVault offer ad ($10, the new_ad
// purchase) plus the same offer on the business's SiteVault site is $12. If
// the site has a SiteVault credit, the site part spends that credit and the
// customer pays $10. Always PAID in AdVault; SiteVault only applies it
// (POST /api/internal/sites/<slug>/offer, idempotent on our purchase id).

import { SITE_OFFER_ADDON, type Currency } from "../pricing/index.js";

export type SiteOfferMode = "paid" | "credit" | "free";

/** What SiteVault's offer-status reports; null when SiteVault was unreachable. */
export type SiteOfferStatus = {
  billing: "on" | "off";
  credits: number;
  siteState: "live" | "grace" | "paused" | "unpublished";
};

export type SiteOfferQuoteInput = {
  /** The campaign's landing_url is a SiteVault site (3pandasite.com). */
  isSiteVaultSite: boolean;
  /** offerBanner(campaign.offerDetails) is non-empty. */
  hasOffer: boolean;
  /** SiteVault's answer, or null when unreachable: never guess. */
  status: SiteOfferStatus | null;
  /** Admins and at_cost accounts: free, like their ads. */
  exempt: boolean;
  currency: Currency;
  /** The customer ticked "Also put this offer on my website". */
  ticked: boolean;
  /** The site already shows exactly this offer: nothing to sell or push. */
  alreadyOnSite?: boolean;
};

export type SiteOfferQuote = {
  /** Show the checkbox at all. */
  available: boolean;
  /** The mode the box offers (shown in its label), null when unavailable. */
  offered: SiteOfferMode | null;
  /** The mode to record on the purchase: `offered` when ticked, else null. */
  mode: SiteOfferMode | null;
  /** The extra line item, in minor units (only for a ticked 'paid'). */
  addonMinor: number;
};

const NONE: SiteOfferQuote = { available: false, offered: null, mode: null, addonMinor: 0 };

export function siteOfferQuote(i: SiteOfferQuoteInput): SiteOfferQuote {
  if (!i.isSiteVaultSite || !i.hasOffer || !i.status || i.alreadyOnSite) return NONE;
  // A paused or unpublished site shows nobody the offer: don't sell it.
  if (i.status.siteState !== "live" && i.status.siteState !== "grace") return NONE;
  let offered: SiteOfferMode;
  let price = 0;
  if (i.exempt || i.status.billing === "off") offered = "free";
  else if (i.status.credits >= 1) offered = "credit";
  else {
    const addon = SITE_OFFER_ADDON[i.currency];
    if (!addon) return NONE;
    offered = "paid";
    price = addon.priceMinor;
  }
  return i.ticked
    ? { available: true, offered, mode: offered, addonMinor: price }
    : { available: true, offered, mode: null, addonMinor: 0 };
}

/** Same offer text, ignoring case, spacing and a trailing full stop. */
export function sameOffer(a: string | null | undefined, b: string | null | undefined): boolean {
  const n = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim().replace(/\.$/, "").toLowerCase();
  return n(a) !== "" && n(a) === n(b);
}

/** The `payment` SiteVault is told: only a credit-mode push spends a SiteVault credit. */
export function sitevaultPayment(mode: SiteOfferMode): "advault" | "credit" {
  return mode === "credit" ? "credit" : "advault";
}

/** Pushes tried before the sweep gives up (the inline one counts). */
export const SITE_OFFER_MAX_ATTEMPTS = 5;

/** Purchase statuses in which the money has been taken. */
const PAID_STATUSES = new Set(["paid", "producing", "delivered"]);

/** Should this purchase's offer be pushed (now, or by the sweep)? */
export function shouldPushSiteOffer(p: {
  siteOfferMode: string | null;
  siteOfferPushedAt: Date | null;
  siteOfferAttempts: number;
  status: string;
}): boolean {
  return (
    p.siteOfferMode !== null &&
    p.siteOfferPushedAt === null &&
    PAID_STATUSES.has(p.status) &&
    p.siteOfferAttempts < SITE_OFFER_MAX_ATTEMPTS
  );
}

export type SiteOfferOutcome = "updated" | "pending" | "retrying" | "failed";

/** What the campaign page's website card says about the latest website offer, or null for nothing. */
export function siteOfferOutcome(p: {
  siteOfferMode: string | null;
  siteOfferPushedAt: Date | null;
  siteOfferError: string | null;
  siteOfferAttempts: number;
  status: string;
}): SiteOfferOutcome | null {
  if (!p.siteOfferMode || !PAID_STATUSES.has(p.status)) return null;
  if (p.siteOfferPushedAt) return "updated";
  if (!p.siteOfferError) return "pending";
  return p.siteOfferAttempts >= SITE_OFFER_MAX_ATTEMPTS ? "failed" : "retrying";
}

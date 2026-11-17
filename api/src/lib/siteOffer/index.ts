// Offer combo: the SiteVault calls and the purchase-row bookkeeping. Pure
// rules live in policy.ts. A SiteVault failure must NEVER fail or delay an ad
// purchase: the push runs after the payment is recorded, records its error,
// and the sweep below retries.

import { and, desc, eq, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { purchases } from "../../db/schema.js";
import { SITEVAULT_URL, offerBanner, slugFromSiteUrl } from "../sitevault/index.js";
import type { Currency } from "../pricing/index.js";
import {
  SITE_OFFER_MAX_ATTEMPTS,
  shouldPushSiteOffer,
  siteOfferOutcome,
  siteOfferQuote,
  sitevaultPayment,
  type SiteOfferMode,
  type SiteOfferOutcome,
  type SiteOfferQuote,
  type SiteOfferStatus,
  sameOffer,
} from "./policy.js";

export type SiteOfferStatusWithSlug = SiteOfferStatus & { slug: string; offer: string | null };

/** SiteVault's offer-status for a site, or null when unconfigured, unknown or unreachable. */
export async function fetchSiteOfferStatus(slug: string): Promise<SiteOfferStatusWithSlug | null> {
  const token = process.env.SITEVAULT_INTERNAL_TOKEN;
  if (!token) return null;
  try {
    const res = await fetch(`${SITEVAULT_URL}/api/internal/sites/${encodeURIComponent(slug)}/offer-status`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const b = (await res.json()) as Partial<SiteOfferStatusWithSlug> & { ok?: boolean };
    if (!b.ok || !b.slug || (b.billing !== "on" && b.billing !== "off") || typeof b.credits !== "number" || !b.siteState) {
      return null;
    }
    return { slug: b.slug, offer: b.offer ?? null, billing: b.billing, credits: b.credits, siteState: b.siteState };
  } catch {
    return null;
  }
}

export type CampaignSiteOffer = SiteOfferQuote & {
  /** The text that would go on the site. */
  offer: string;
  /** The site's CURRENT slug (after any rename), when SiteVault answered. */
  slug: string | null;
  credits: number | null;
};

/** The quote for one campaign, asking SiteVault server-side. */
export async function quoteCampaignSiteOffer(args: {
  campaign: { landingUrl: string | null; offerDetails: string | null };
  exempt: boolean;
  currency: Currency;
  ticked: boolean;
}): Promise<CampaignSiteOffer> {
  const slug = slugFromSiteUrl(args.campaign.landingUrl);
  const offer = offerBanner(args.campaign.offerDetails);
  const status = slug && offer ? await fetchSiteOfferStatus(slug) : null;
  const quote = siteOfferQuote({
    isSiteVaultSite: Boolean(slug),
    hasOffer: Boolean(offer),
    status,
    exempt: args.exempt,
    currency: args.currency,
    ticked: args.ticked,
    // A website made from this campaign already carries its offer.
    alreadyOnSite: sameOffer(status?.offer, offer),
  });
  return { ...quote, offer, slug: status?.slug ?? null, credits: status?.credits ?? null };
}

/** Record the chosen mode on a purchase (at checkout time). */
export async function recordSiteOffer(purchaseId: string, mode: SiteOfferMode, text: string, slug: string): Promise<void> {
  await db
    .update(purchases)
    .set({ siteOfferMode: mode, siteOfferText: text, siteOfferSlug: slug, updatedAt: new Date() })
    .where(eq(purchases.id, purchaseId));
}

/**
 * Push a paid purchase's offer to SiteVault once. Never throws. SiteVault is
 * idempotent on `ref` (the purchase id), so the inline push and the sweep
 * racing each other cannot spend a SiteVault credit twice.
 */
export async function pushSiteOffer(purchaseId: string): Promise<"pushed" | "skipped" | "failed"> {
  try {
    const [p] = await db.select().from(purchases).where(eq(purchases.id, purchaseId)).limit(1);
    if (!p || !shouldPushSiteOffer(p) || !p.siteOfferText || !p.siteOfferSlug) return "skipped";
    const token = process.env.SITEVAULT_INTERNAL_TOKEN;
    let error: string | null = null;
    if (!token) error = "sitevault_not_configured";
    else {
      try {
        const res = await fetch(`${SITEVAULT_URL}/api/internal/sites/${encodeURIComponent(p.siteOfferSlug)}/offer`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({
            offer: p.siteOfferText,
            payment: sitevaultPayment(p.siteOfferMode as SiteOfferMode),
            ref: p.id,
          }),
          signal: AbortSignal.timeout(10_000),
        });
        const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; detail?: string; creditShort?: boolean };
        if (!res.ok || !body.ok) error = `sitevault_${res.status}${body.error ? `:${body.error}` : ""}${body.detail ? ` ${body.detail}` : ""}`;
        else if (body.creditShort) console.warn(JSON.stringify({ msg: "site offer set with no SiteVault credit left", purchaseId: p.id }));
      } catch (err) {
        error = `sitevault_unreachable: ${String(err)}`;
      }
    }
    const now = new Date();
    await db
      .update(purchases)
      .set(
        error
          ? { siteOfferError: error.slice(0, 500), siteOfferAttempts: sql`${purchases.siteOfferAttempts} + 1`, updatedAt: now }
          : { siteOfferPushedAt: now, siteOfferError: null, siteOfferAttempts: sql`${purchases.siteOfferAttempts} + 1`, updatedAt: now },
      )
      .where(eq(purchases.id, p.id));
    if (error) console.warn(JSON.stringify({ msg: "site offer push failed", purchaseId: p.id, error }));
    return error ? "failed" : "pushed";
  } catch (err) {
    console.error(JSON.stringify({ msg: "site offer push threw", purchaseId, error: String(err) }));
    return "failed";
  }
}

/** The campaign's latest paid website offer and how it went, for the website card. */
export async function latestSiteOffer(campaignId: string): Promise<{ outcome: SiteOfferOutcome; offer: string | null } | null> {
  const [p] = await db
    .select({
      siteOfferMode: purchases.siteOfferMode,
      siteOfferPushedAt: purchases.siteOfferPushedAt,
      siteOfferError: purchases.siteOfferError,
      siteOfferAttempts: purchases.siteOfferAttempts,
      siteOfferText: purchases.siteOfferText,
      status: purchases.status,
    })
    .from(purchases)
    .where(
      and(
        eq(purchases.campaignId, campaignId),
        isNotNull(purchases.siteOfferMode),
        inArray(purchases.status, ["paid", "producing", "delivered"]),
      ),
    )
    .orderBy(desc(purchases.createdAt))
    .limit(1);
  const outcome = p ? siteOfferOutcome(p) : null;
  return outcome ? { outcome, offer: p!.siteOfferText } : null;
}

/** Fire-and-forget push after a payment is recorded: never awaited by the payment path. */
export function pushSiteOfferSoon(purchaseId: string): void {
  setImmediate(() => void pushSiteOffer(purchaseId));
}

/**
 * Retries un-pushed paid site offers. Skips rows touched in the last minute
 * so it doesn't race the inline push; SiteVault's ref idempotency makes a
 * race harmless anyway.
 */
export async function runSiteOfferSweep(): Promise<{ pushed: number; failed: number }> {
  const due = await db
    .select({ id: purchases.id })
    .from(purchases)
    .where(
      and(
        isNotNull(purchases.siteOfferMode),
        isNull(purchases.siteOfferPushedAt),
        inArray(purchases.status, ["paid", "producing", "delivered"]),
        lt(purchases.siteOfferAttempts, SITE_OFFER_MAX_ATTEMPTS),
        lt(purchases.updatedAt, sql`now() - interval '1 minute'`),
      ),
    )
    .orderBy(purchases.createdAt)
    .limit(20);
  let pushed = 0;
  let failed = 0;
  for (const { id } of due) {
    const r = await pushSiteOffer(id);
    if (r === "pushed") pushed += 1;
    else if (r === "failed") failed += 1;
  }
  return { pushed, failed };
}

/** Every 10 minutes in the API (the only process holding SITEVAULT_INTERNAL_TOKEN). */
export function startSiteOfferSweep(intervalMs = 10 * 60 * 1000): void {
  const tick = () =>
    runSiteOfferSweep()
      .then((r) => {
        if (r.pushed || r.failed) console.log(JSON.stringify({ msg: "site offer sweep", ...r }));
      })
      .catch((err) => console.error(JSON.stringify({ msg: "site offer sweep threw", error: String(err) })));
  setInterval(tick, intervalMs).unref();
}

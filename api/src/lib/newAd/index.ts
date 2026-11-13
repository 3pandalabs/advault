import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { purchases } from "../../db/schema.js";
import { entitlesToService, type SubscriptionStatus } from "../subscriptions/policy.js";
import { liveSubscriptionFor } from "../subscriptions/index.js";
import { formatMinor, freeFirstAd } from "../pricing/index.js";
import { quoteFor, type Quote } from "../cinematic/index.js";

const CLAIMED = ["paid", "producing", "delivered"] as const;

/** Free ads claimed so far by anyone (the launch offer's counter). */
export async function freeAdsClaimed(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(distinct ${purchases.userId})::int` })
    .from(purchases)
    .where(and(eq(purchases.sku, "new_ad"), eq(purchases.amountMinor, 0), inArray(purchases.status, [...CLAIMED])));
  return row?.n ?? 0;
}

export type NewAdQuote = Quote & { freeLaunchOffer: boolean };

/** The $10 ad, or $0 while the launch offer has places and this is their first. */
export async function quoteNewAd(userId: string): Promise<NewAdQuote> {
  const quote = await quoteFor(userId, "new_ad");
  const [mine] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(purchases)
    .where(and(eq(purchases.userId, userId), eq(purchases.sku, "new_ad"), inArray(purchases.status, [...CLAIMED])));
  const free = freeFirstAd({ priorAdsClaimed: mine?.n ?? 0, freeAdsClaimedByAnyone: await freeAdsClaimed() });
  return free ? { ...quote, amountMinor: 0, freeLaunchOffer: true } : { ...quote, freeLaunchOffer: false };
}


// The $10 new ad for Keep it running (evergreen) subscribers.
//
// That plan's fee bundles no creatives, so before AdVault writes and renders
// an ad for one of its campaigns, a `new_ad` purchase must be paid. The order
// carries the wizard's choices (photos, formats) in `brief`, and once paid the
// campaign page calls POST /new-ad/orders/:id/generate, which spends it.
//
// Status use: pending (checkout open) -> paid (money taken, ad not made yet)
// -> producing (generating right now) -> delivered (creatives queued).

export type NewAdBrief = { assetIds: string[]; aspectRatios: ("16:9" | "9:16")[] };

/** Does this user pay per ad? Only live Keep it running subscribers do. */
export async function paysPerAd(userId: string): Promise<boolean> {
  const sub = await liveSubscriptionFor(userId);
  return !!sub && sub.line === "evergreen" && entitlesToService(sub.status as SubscriptionStatus);
}

/** Has this campaign's ad already been paid for and made? */
export async function campaignHasPaidAd(campaignId: string): Promise<boolean> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(purchases)
    .where(
      and(
        eq(purchases.campaignId, campaignId),
        eq(purchases.sku, "new_ad"),
        inArray(purchases.status, ["producing", "delivered"]),
      ),
    );
  return (row?.n ?? 0) > 0;
}

/**
 * The 402 body when generating this campaign's ad needs a payment first, or
 * null when it may go ahead.
 */
export async function newAdGate(userId: string, campaignId: string) {
  if (!(await paysPerAd(userId))) return null;
  if (await campaignHasPaidAd(campaignId)) return null;
  const quote = await quoteNewAd(userId);
  return {
    error: "new_ad_payment_required",
    amountMinor: quote.amountMinor,
    currency: quote.currency,
    display: formatMinor(quote.amountMinor, quote.currency),
    freeLaunchOffer: quote.freeLaunchOffer,
  };
}

/**
 * Take a paid order for generation. Atomic, so a double click or two tabs
 * cannot make (and bill the vendor for) the same ad twice. An order stuck in
 * `producing` for 10 minutes (process died mid-way) can be taken again.
 */
export async function claimNewAdOrder(purchaseId: string) {
  const [row] = await db
    .update(purchases)
    .set({ status: "producing", attempts: sql`${purchases.attempts} + 1`, updatedAt: new Date() })
    .where(
      and(
        eq(purchases.id, purchaseId),
        eq(purchases.sku, "new_ad"),
        sql`(${purchases.status} = 'paid' or (${purchases.status} = 'producing' and ${purchases.updatedAt} < now() - interval '10 minutes'))`,
      ),
    )
    .returning();
  return row ?? null;
}

/** Generation refused or crashed: hand the order back so it can be retried. */
export async function releaseNewAdOrder(purchaseId: string, error: unknown) {
  await db
    .update(purchases)
    .set({ status: "paid", lastError: String(error).slice(0, 1000), updatedAt: new Date() })
    .where(eq(purchases.id, purchaseId));
}

import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { purchases, users } from "../../db/schema.js";
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


// The $10 new ad. Since 2026-11-13 EVERY advertiser pays it before AdVault
// writes and renders an ad (it used to be Keep it running subscribers only,
// which let anyone without a plan get ads made free while we paid the
// vendors). Admins and at_cost accounts are exempt, same as the launch gate.
//
// A paid ad includes RENDERS_PER_AD renders: the first, plus redos (generate
// again, or a script edit that re-renders). A render that FAILED is retried
// free. Past the allowance the campaign needs another $10 ad. The order
// carries the wizard's choices (photos, formats) in `brief`, and once paid the
// campaign page calls POST /new-ad/orders/:id/generate, which spends it.
//
// Status use: pending (checkout open) -> paid (money taken, ad not made yet)
// -> producing (generating right now) -> delivered (creatives queued).

export type NewAdBrief = { assetIds: string[]; aspectRatios: ("16:9" | "9:16")[] };

/** First render + two redos per paid ad. */
export const RENDERS_PER_AD = 3;

/** Does this user pay per ad? Everyone but admins and at_cost accounts. */
export async function paysPerAd(userId: string): Promise<boolean> {
  const [u] = await db
    .select({ role: users.role, marginMode: users.marginMode })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return !!u && u.role !== "admin" && u.marginMode !== "at_cost";
}

/**
 * Does this campaign have a paid ad with renders left (or one paid and not
 * yet made)? Then a new $10 order would charge twice for the same ad.
 */
export async function campaignHasPaidAd(campaignId: string): Promise<boolean> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(purchases)
    .where(
      and(
        eq(purchases.campaignId, campaignId),
        eq(purchases.sku, "new_ad"),
        sql`(${purchases.status} in ('paid', 'producing') or (${purchases.status} = 'delivered' and ${purchases.rendersUsed} < ${RENDERS_PER_AD}))`,
      ),
    );
  return (row?.n ?? 0) > 0;
}

/**
 * Spends one render from the campaign's delivered ad, atomically. Returns
 * the order id it was taken from, or null when none has renders left.
 */
export async function takeRender(campaignId: string): Promise<string | null> {
  const res = await db.execute(sql`
    update purchases set renders_used = renders_used + 1, updated_at = now()
    where id = (
      select id from purchases
      where campaign_id = ${campaignId} and sku = 'new_ad' and status = 'delivered'
        and renders_used < ${RENDERS_PER_AD}
      order by created_at desc limit 1
      for update skip locked
    )
    returning id`);
  return (res.rows[0] as { id: string } | undefined)?.id ?? null;
}

/** Gives back a render whose generation was refused (daily cap, no photos…). */
export async function returnRender(purchaseId: string): Promise<void> {
  await db
    .update(purchases)
    .set({ rendersUsed: sql`greatest(${purchases.rendersUsed} - 1, 0)`, updatedAt: new Date() })
    .where(eq(purchases.id, purchaseId));
}

export type GateResult =
  | { ok: true; renderFrom: string | null }
  | { ok: false; body: Record<string, unknown> };

/**
 * May this user (re)render this campaign's ad? Exempt users always may. A
 * payer spends one render from the campaign's paid ad; with none left the
 * answer is a 402 asking for another $10 ad. On a refused generation, call
 * returnRender(renderFrom).
 */
export async function newAdGate(userId: string, campaignId: string): Promise<GateResult> {
  if (!(await paysPerAd(userId))) return { ok: true, renderFrom: null };
  const taken = await takeRender(campaignId);
  if (taken) return { ok: true, renderFrom: taken };
  const quote = await quoteNewAd(userId);
  return {
    ok: false,
    body: {
      error: "new_ad_payment_required",
      amountMinor: quote.amountMinor,
      currency: quote.currency,
      display: formatMinor(quote.amountMinor, quote.currency),
      freeLaunchOffer: quote.freeLaunchOffer,
      rendersPerAd: RENDERS_PER_AD,
    },
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

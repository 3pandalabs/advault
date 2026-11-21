import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { purchases, users } from "../../db/schema.js";
import {
  addOnByKey,
  addOnFor,
  addOnPriceMinor,
  chargeMinor,
  currencyForCountry,
  type AddOn,
  type AddOnSku,
  type Currency,
  type MarginMode,
} from "../pricing/index.js";
import { applyEntry, DuplicateLedgerEntry } from "../wallet/index.js";
import { inTestMode } from "../testMode/policy.js";
import { isProducible, purchaseLedgerRefs, shouldRetryProduction } from "./policy.js";

// The one-off purchase lifecycle. Read ./policy.ts first — the states, the
// refund rule and the guardrails live there and are tested; this is the
// database side of the same story.
//
// The money rule is identical to the subscription path and is not optional:
// EVERY rupee of platform revenue is a `fee` ledger row, whichever rail
// collected it, so "what did AdVault earn" stays one query over one column.

export class NoSuchAddOn extends Error {
  constructor(readonly key: string) {
    super("no_such_add_on");
  }
}

export class PurchaseNotProducible extends Error {
  constructor(readonly status: string) {
    super("purchase_not_producible");
  }
}

/**
 * How many of this SKU the user has already PAID for.
 *
 * Counted from money actually taken, never from orders created — otherwise an
 * abandoned checkout would burn the intro price and the customer would be
 * quoted full freight for an ad they never got.
 */
export async function priorPaidCount(userId: string, sku: AddOnSku): Promise<number> {
  // A pack bought counts as having bought cinematic: the $29 intro price is
  // for trying it once, and a pack buyer already has.
  const skus = sku === "cinematic" ? ["cinematic", "cinematic_pack"] : [sku];
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(purchases)
    .where(
      and(
        eq(purchases.userId, userId),
        inArray(purchases.sku, skus),
        sql`${purchases.status} in ('paid','producing','delivered')`,
      ),
    );
  return row?.n ?? 0;
}

/**
 * Unspent pack credits: credits from paid packs minus cinematic orders paid
 * with one. A pack order that FAILED gives its credit back automatically
 * (only paid/producing/delivered orders count as spent), which is the pack
 * equivalent of the refund a card-paid failure gets.
 */
export async function packCreditsLeft(userId: string, executor: Pick<typeof db, "execute"> = db): Promise<number> {
  const res = await executor.execute(sql`
    select
      coalesce((select sum(3) from purchases
        where user_id = ${userId} and sku = 'cinematic_pack'
          and status in ('paid','producing','delivered')), 0)::int as granted,
      (select count(*) from purchases
        where user_id = ${userId} and sku = 'cinematic' and provider = 'pack'
          and status in ('paid','producing','delivered'))::int as spent
  `);
  const row = res.rows[0] as { granted: number; spent: number } | undefined;
  return Math.max(0, Number(row?.granted ?? 0) - Number(row?.spent ?? 0));
}

export type Quote = {
  addOn: AddOn;
  amountMinor: number;
  isFirstPurchase: boolean;
  currency: Currency;
  /** Admin testing as a customer: amountMinor is the $0.50 test price. */
  testMode: boolean;
  /** 3PandaLabs' own account (0032): full price; Stripe tags it `internal=1`. */
  internal: boolean;
  internalLabel: string | null;
};

export async function quoteFor(
  userId: string,
  sku: AddOnSku,
  marginMode: MarginMode = "standard",
): Promise<Quote> {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  const currency = currencyForCountry(user?.countryCode ?? "US");
  const addOn = addOnFor(currency, sku);
  const prior = await priorPaidCount(userId, sku);
  const testMode = inTestMode(user ?? { role: null });
  return {
    addOn,
    amountMinor: chargeMinor(
      addOnPriceMinor(addOn, { priorPaidCount: prior, marginMode: testMode ? "standard" : marginMode }),
      testMode,
    ),
    isFirstPurchase: prior === 0,
    currency,
    testMode,
    internal: user?.isInternal === true,
    internalLabel: user?.isInternal ? (user.internalLabel ?? null) : null,
  };
}

export async function createPurchase(args: {
  userId: string;
  addOnKey: string;
  campaignId?: string | null;
  provider: string;
  amountMinor: number;
  providerRef?: string | null;
}) {
  const addOn = addOnByKey(args.addOnKey);
  if (!addOn) throw new NoSuchAddOn(args.addOnKey);

  const [row] = await db
    .insert(purchases)
    .values({
      userId: args.userId,
      campaignId: args.campaignId ?? null,
      addOnKey: addOn.key,
      sku: addOn.sku,
      currencyCode: addOn.currency,
      // Copied from the quote, not recomputed here. Recomputing at capture time
      // would let a price-list edit between checkout and webhook charge someone
      // a different number from the one they agreed to.
      amountMinor: args.amountMinor,
      provider: args.provider,
      providerRef: args.providerRef ?? null,
      status: "pending",
    })
    .returning();
  return row;
}

/**
 * Money taken. Writes the revenue and moves the order into the render queue.
 *
 * Idempotent by ledger `external_ref`, because both PSPs retry webhook
 * delivery by design and a retried delivery must not book the sale twice.
 */
export async function markPurchasePaid(args: {
  purchaseId: string;
  externalRef: string;
  now?: Date;
}): Promise<{ alreadyApplied: boolean }> {
  const now = args.now ?? new Date();

  const [purchase] = await db
    .select()
    .from(purchases)
    .where(eq(purchases.id, args.purchaseId))
    .limit(1);
  if (!purchase) throw new Error(`unknown_purchase:${args.purchaseId}`);
  if (purchase.status !== "pending") return { alreadyApplied: true };

  const currency = purchase.currencyCode as Currency;
  const refs = purchaseLedgerRefs(purchase.id);

  // A one-off add-on is ALWAYS externally funded — the advertiser's own card
  // pays for it. There is no wallet-funded variant, because the wallet exists
  // to front Google ad spend for platform-billed managed accounts and this
  // product buys no media at all. So the paired credit is unconditional, and
  // the balance nets to zero while the fee row records the revenue.
  //
  // The waiver case writes nothing: an at_cost order earned nothing, and a
  // zero-amount pair would be two rows saying so.
  if (purchase.amountMinor > 0) {
    try {
      await applyEntry({
        userId: purchase.userId,
        currency,
        type: "topup",
        amountMinor: purchase.amountMinor,
        description:
          purchase.sku === "new_ad"
            ? "New ad payment received"
            : purchase.sku === "cinematic_pack"
              ? "Cinematic 3-pack payment received"
              : purchase.sku === "offer_change"
                ? "Offer change payment received"
                : "Cinematic ad payment received",
        externalRef: refs.credit,
      });
    } catch (err) {
      if (!(err instanceof DuplicateLedgerEntry)) throw err;
    }

    try {
      await applyEntry({
        userId: purchase.userId,
        currency,
        type: "fee",
        amountMinor: -purchase.amountMinor,
        description: `AdVault ${purchase.sku} — ${purchase.addOnKey}`,
        externalRef: refs.fee,
        // Paired with the credit above, so it can never overdraw. Passing
        // false here would fail a charge whose card has already succeeded.
        allowOverdraft: true,
      });
    } catch (err) {
      if (err instanceof DuplicateLedgerEntry) return { alreadyApplied: true };
      throw err;
    }
  }

  await db
    .update(purchases)
    .set({
      status: "paid",
      paidAt: now,
      providerRef: args.externalRef,
      updatedAt: now,
    })
    .where(eq(purchases.id, purchase.id));

  return { alreadyApplied: false };
}

/**
 * Claim one paid order for production.
 *
 * FOR UPDATE SKIP LOCKED for the same reason the render queue uses it: the
 * moment a second renderer replica exists, two workers would generate the same
 * ad and bill the vendor twice for footage only one of them can deliver.
 */
export async function claimNextPurchase(): Promise<typeof purchases.$inferSelect | null> {
  // Raw SQL returns snake_case columns (add_on_key, user_id...), not the
  // camelCase drizzle shape, so only the id is taken from it and the row is
  // re-read through drizzle. Reading it as $inferSelect left every field
  // undefined ("unknown add-on undefined", first real order 2026-11-14).
  const rows = await db.execute<{ id: string }>(sql`
    with claimed as (
      select id from purchases
      where status = 'paid'
        -- new_ad orders are generated by their own route, never here.
        and sku = 'cinematic'
      order by created_at
      for update skip locked
      limit 1
    )
    update purchases p
       set status = 'producing',
           attempts = p.attempts + 1,
           updated_at = now()
      from claimed
     where p.id = claimed.id
    returning p.id
  `);
  const id = (rows as unknown as { rows?: { id: string }[] }).rows?.[0]?.id;
  if (!id) return null;
  const [row] = await db.select().from(purchases).where(eq(purchases.id, id)).limit(1);
  return row ?? null;
}

export async function attachBrief(purchaseId: string, brief: unknown): Promise<void> {
  await db
    .update(purchases)
    .set({ brief: brief as object, updatedAt: new Date() })
    .where(eq(purchases.id, purchaseId));
}

export async function markDelivered(purchaseId: string): Promise<void> {
  const now = new Date();
  await db
    .update(purchases)
    .set({ status: "delivered", deliveredAt: now, lastError: null, updatedAt: now })
    .where(eq(purchases.id, purchaseId));
}

/**
 * Production failed after the money was taken.
 *
 * Goes back to `paid` while retries remain so the renderer picks it up again,
 * and only lands on `failed` once they are exhausted. `failed` is deliberately
 * a REFUNDABLE state, not a terminal one — the customer paid for an ad they do
 * not have, and nothing else in this system will notice that for them.
 */
export async function markProductionFailed(args: {
  purchaseId: string;
  attempts: number;
  error: unknown;
}): Promise<{ willRetry: boolean }> {
  const willRetry = shouldRetryProduction(args.attempts);
  const now = new Date();
  await db
    .update(purchases)
    .set({
      status: willRetry ? "paid" : "failed",
      lastError: String(args.error).slice(0, 1000),
      updatedAt: now,
    })
    .where(eq(purchases.id, args.purchaseId));
  return { willRetry };
}

export async function assertProducible(purchaseId: string): Promise<void> {
  const [row] = await db
    .select({ status: purchases.status })
    .from(purchases)
    .where(eq(purchases.id, purchaseId))
    .limit(1);
  if (!row || !isProducible(row.status as never)) {
    throw new PurchaseNotProducible(row?.status ?? "missing");
  }
}

/** Add-on revenue, for /metrics. Only rows that actually took money. */
export async function addOnRevenueTotals(): Promise<
  { currency: Currency; totalMinor: number; count: number }[]
> {
  const rows = await db
    .select({
      currency: purchases.currencyCode,
      totalMinor: sql<number>`coalesce(sum(${purchases.amountMinor}),0)::int`,
      count: sql<number>`count(*)::int`,
    })
    .from(purchases)
    .where(sql`${purchases.status} in ('paid','producing','delivered') and ${purchases.amountMinor} > 0`)
    .groupBy(purchases.currencyCode);
  return rows.map((r) => ({ ...r, currency: r.currency as Currency }));
}

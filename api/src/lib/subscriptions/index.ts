import { and, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  adAccounts,
  subscriptionInvoices,
  subscriptions,
  users,
} from "../../db/schema.js";
import type { BillingMode } from "../billing/policy.js";
import { planByKey, type Currency, type Plan } from "../pricing/index.js";
import { applyEntry, DuplicateLedgerEntry } from "../wallet/index.js";
import {
  dunningDecision,
  entitlesToService,
  feeFunding,
  feeLedgerRefs,
  firstPeriod,
  nextPeriod,
  type Period,
  type SubscriptionStatus,
} from "./policy.js";

// The subscription lifecycle, and the only place a `fee` ledger row is written.
//
// Read ./policy.ts first — the arithmetic and the funding rules live there and
// are tested. This module is the database and provider side of the same story.

export class NoSuchPlan extends Error {
  constructor(readonly planKey: string) {
    super("no_such_plan");
  }
}

export class AlreadySubscribed extends Error {
  constructor() {
    super("already_subscribed");
  }
}

const LIVE_STATUSES = ["pending", "active", "past_due"] as const;

export async function liveSubscriptionFor(userId: string) {
  const [row] = await db
    .select()
    .from(subscriptions)
    .where(
      and(eq(subscriptions.userId, userId), inArray(subscriptions.status, [...LIVE_STATUSES])),
    )
    .orderBy(desc(subscriptions.createdAt))
    .limit(1);
  return row ?? null;
}

/** Is this user entitled to have work done for them right now? */
export async function hasServiceEntitlement(userId: string): Promise<boolean> {
  const sub = await liveSubscriptionFor(userId);
  return sub ? entitlesToService(sub.status as SubscriptionStatus) : false;
}

/**
 * The billing mode that decides where this user's fee is funded from.
 *
 * Read off their active ad account, because that is where "whose card does
 * Google charge" actually lives. Null when they have no ad account at all —
 * which is the normal case on the offer line, and is why feeFunding() treats
 * null as external rather than defaulting to the wallet.
 */
export async function billingModeFor(userId: string): Promise<BillingMode | null> {
  const [row] = await db
    .select({ billingMode: adAccounts.billingMode })
    .from(adAccounts)
    .where(and(eq(adAccounts.userId, userId), eq(adAccounts.status, "active")))
    .limit(1);
  return (row?.billingMode as BillingMode | undefined) ?? null;
}

/**
 * Creates a subscription in `pending` and opens its first invoice.
 *
 * Nothing is charged here. The caller hands the invoice to a provider, and the
 * subscription only becomes `active` when a verified webhook says the money
 * arrived — the same "row before provider call" discipline `payments` uses, for
 * the same reason: an abandoned checkout should be visible, not absent.
 */
export async function createSubscription(args: {
  userId: string;
  planKey: string;
  provider: "razorpay" | "stripe" | "paddle" | "manual";
  now?: Date;
}) {
  const plan = planByKey(args.planKey);
  if (!plan) throw new NoSuchPlan(args.planKey);

  const existing = await liveSubscriptionFor(args.userId);
  if (existing) throw new AlreadySubscribed();

  const now = args.now ?? new Date();
  const period = firstPeriod(now);

  try {
    return await db.transaction(async (tx) => {
      const [sub] = await tx
        .insert(subscriptions)
        .values({
          userId: args.userId,
          planKey: plan.key,
          line: plan.line,
          currencyCode: plan.currency,
          amountMinor: plan.monthlyFeeMinor,
          provider: args.provider,
          status: "pending",
          currentPeriodStart: period.start,
          currentPeriodEnd: period.end,
        })
        .returning();

      const [invoice] = await tx
        .insert(subscriptionInvoices)
        .values({
          subscriptionId: sub.id,
          userId: args.userId,
          amountMinor: plan.monthlyFeeMinor,
          currencyCode: plan.currency,
          periodStart: period.start,
          periodEnd: period.end,
          status: "pending",
        })
        .returning();

      return { subscription: sub, invoice, plan };
    });
  } catch (err) {
    // The partial unique index on (user_id) where status in (live) is what
    // actually stops a double-submitted checkout from billing someone twice a
    // month forever. The read above is a courtesy; this is the guarantee.
    if ((err as { code?: string }).code === "23505") throw new AlreadySubscribed();
    throw err;
  }
}

/**
 * Records that an invoice was paid, and posts the revenue.
 *
 * This is THE function that makes AdVault a business rather than a renderer.
 * Everything it does happens in one transaction so that a crash between the
 * invoice update and the ledger write cannot leave money collected and
 * unrecorded.
 *
 * Idempotent twice over: `uq_sub_invoices_ref` catches a replayed provider
 * event on the invoice, and the wallet's own (wallet_id, external_ref) index
 * catches it on the ledger. Both Razorpay and Stripe retry by design, and
 * Paddle retries for up to three days.
 */
export async function markInvoicePaid(args: {
  invoiceId: string;
  externalRef: string;
  providerPayload?: unknown;
  now?: Date;
}): Promise<{ alreadyApplied: boolean }> {
  const now = args.now ?? new Date();

  const [invoice] = await db
    .select()
    .from(subscriptionInvoices)
    .where(eq(subscriptionInvoices.id, args.invoiceId))
    .limit(1);
  if (!invoice) throw new Error(`unknown_invoice:${args.invoiceId}`);
  if (invoice.status === "paid") return { alreadyApplied: true };

  const [sub] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.id, invoice.subscriptionId))
    .limit(1);

  const currency = invoice.currencyCode as Currency;
  const funding = feeFunding(
    sub.line as Plan["line"],
    sub.line === "managed" ? await billingModeFor(invoice.userId) : null,
  );
  const refs = feeLedgerRefs(invoice.id);

  // The paired credit for externally-funded fees. Posted first and separately
  // from the debit: if the two were one entry the ledger would record a net
  // zero and AdVault's revenue would be invisible, which is the whole thing
  // this table exists to make visible.
  if (funding === "external") {
    try {
      await applyEntry({
        userId: invoice.userId,
        currency,
        type: "topup",
        amountMinor: invoice.amountMinor,
        description: "Subscription payment received",
        externalRef: refs.credit,
      });
    } catch (err) {
      if (!(err instanceof DuplicateLedgerEntry)) throw err;
    }
  }

  try {
    await applyEntry({
      userId: invoice.userId,
      currency,
      type: "fee",
      amountMinor: -invoice.amountMinor,
      description: `AdVault subscription — ${sub.planKey}`,
      externalRef: refs.fee,
      // Wallet-funded fees must NOT overdraw: a platform-billed advertiser
      // whose balance cannot cover the fee is genuinely unfunded, and letting
      // it go negative would hand them ad budget we then front at Google.
      allowOverdraft: false,
    });
  } catch (err) {
    if (err instanceof DuplicateLedgerEntry) return { alreadyApplied: true };
    throw err;
  }

  const period: Period = { start: invoice.periodStart, end: invoice.periodEnd };
  await db.transaction(async (tx) => {
    await tx
      .update(subscriptionInvoices)
      .set({
        status: "paid",
        paidAt: now,
        externalRef: args.externalRef,
        providerPayload: (args.providerPayload ?? null) as object | null,
        attemptCount: invoice.attemptCount + 1,
        updatedAt: now,
      })
      .where(eq(subscriptionInvoices.id, invoice.id));

    await tx
      .update(subscriptions)
      .set({
        status: "active",
        failedChargeCount: 0,
        currentPeriodStart: period.start,
        currentPeriodEnd: period.end,
        updatedAt: now,
      })
      .where(eq(subscriptions.id, sub.id));
  });

  return { alreadyApplied: false };
}

/**
 * Records a failed charge and applies the dunning ladder.
 *
 * Deliberately keeps serving while inside the grace window — see the reasoning
 * in policy.ts. The subscription only reaches `expired` when the retries or the
 * window run out, and that is the single place service actually stops.
 */
export async function markInvoiceFailed(args: {
  invoiceId: string;
  reason: string;
  now?: Date;
}): Promise<{ status: SubscriptionStatus; nextAttemptAt: Date | null }> {
  const now = args.now ?? new Date();

  const [invoice] = await db
    .select()
    .from(subscriptionInvoices)
    .where(eq(subscriptionInvoices.id, args.invoiceId))
    .limit(1);
  if (!invoice) throw new Error(`unknown_invoice:${args.invoiceId}`);

  const [sub] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.id, invoice.subscriptionId))
    .limit(1);

  const failedCount = sub.failedChargeCount + 1;
  const decision = dunningDecision({
    failedChargeCount: failedCount,
    // First failure of this period is what the grace window runs from — not the
    // first failure ever, or a customer who recovered once would carry a
    // shortened window forever.
    firstFailureAt: invoice.paidAt ?? invoice.periodEnd,
    now,
  });

  const status: SubscriptionStatus = decision.action === "expire" ? "expired" : "past_due";

  await db.transaction(async (tx) => {
    await tx
      .update(subscriptionInvoices)
      .set({
        status: decision.action === "expire" ? "failed" : "pending",
        attemptCount: invoice.attemptCount + 1,
        failureReason: args.reason.slice(0, 500),
        updatedAt: now,
      })
      .where(eq(subscriptionInvoices.id, invoice.id));

    await tx
      .update(subscriptions)
      .set({ status, failedChargeCount: failedCount, updatedAt: now })
      .where(eq(subscriptions.id, sub.id));
  });

  return {
    status,
    nextAttemptAt: decision.action === "retry" ? decision.nextAttemptAt : null,
  };
}

/**
 * Opens the next period's invoice for a subscription whose period has ended.
 *
 * Returns null when one already exists — `uq_sub_invoices_period` makes that a
 * caught duplicate rather than a second charge, which is what lets the renewal
 * sweep run as often as it likes.
 */
export async function openNextInvoice(subscriptionId: string, now = new Date()) {
  const [sub] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.id, subscriptionId))
    .limit(1);
  if (!sub || !sub.currentPeriodStart || !sub.currentPeriodEnd) return null;

  const period = nextPeriod({ start: sub.currentPeriodStart, end: sub.currentPeriodEnd });

  try {
    const [invoice] = await db
      .insert(subscriptionInvoices)
      .values({
        subscriptionId: sub.id,
        userId: sub.userId,
        amountMinor: sub.amountMinor,
        currencyCode: sub.currencyCode,
        periodStart: period.start,
        periodEnd: period.end,
        status: "pending",
      })
      .returning();
    return { invoice, subscription: sub, period };
  } catch (err) {
    if ((err as { code?: string }).code === "23505") return null;
    throw err;
  }
}

/**
 * Which invoice does an incoming provider payment actually pay for?
 *
 * This exists because of a subtlety that would otherwise silently break month
 * two. Provider metadata is fixed when the mandate is created, so EVERY renewal
 * webhook — for years — carries the id of the FIRST invoice. Taking that at
 * face value means the second month's payment is dismissed as a duplicate of
 * the first, the subscription never advances its period, and the customer is
 * charged monthly for a subscription our database still thinks is in month one.
 *
 * So the metadata id is treated as a hint that identifies the SUBSCRIPTION, and
 * the payment is applied to whichever invoice is currently open — opening the
 * next period's if the sweep has not yet.
 *
 * Idempotency is preserved by the caller: `uq_sub_invoices_ref` rejects an
 * external ref already recorded against this subscription, so a genuinely
 * replayed webhook still lands as a duplicate rather than a fresh month.
 */
export async function resolveInvoiceForPayment(args: {
  hintInvoiceId: string;
  externalRef: string;
}): Promise<{ invoiceId: string; alreadyApplied: boolean } | null> {
  const [hint] = await db
    .select()
    .from(subscriptionInvoices)
    .where(eq(subscriptionInvoices.id, args.hintInvoiceId))
    .limit(1);
  if (!hint) return null;

  // Already recorded against this subscription: a true replay.
  const [seen] = await db
    .select({ id: subscriptionInvoices.id })
    .from(subscriptionInvoices)
    .where(
      and(
        eq(subscriptionInvoices.subscriptionId, hint.subscriptionId),
        eq(subscriptionInvoices.externalRef, args.externalRef),
      ),
    )
    .limit(1);
  if (seen) return { invoiceId: seen.id, alreadyApplied: true };

  if (hint.status !== "paid") return { invoiceId: hint.id, alreadyApplied: false };

  // The hinted invoice is settled, so this is a renewal. Use the open one.
  const [open] = await db
    .select({ id: subscriptionInvoices.id })
    .from(subscriptionInvoices)
    .where(
      and(
        eq(subscriptionInvoices.subscriptionId, hint.subscriptionId),
        eq(subscriptionInvoices.status, "pending"),
      ),
    )
    .orderBy(desc(subscriptionInvoices.periodStart))
    .limit(1);
  if (open) return { invoiceId: open.id, alreadyApplied: false };

  // Provider billed ahead of our sweep. Open the period now rather than
  // rejecting money that has already been taken from a customer.
  const opened = await openNextInvoice(hint.subscriptionId);
  return opened ? { invoiceId: opened.invoice.id, alreadyApplied: false } : null;
}

/** Subscriptions whose paid period has ended and which are still serving. */
export async function dueForRenewal(now = new Date(), limit = 200) {
  return db
    .select()
    .from(subscriptions)
    .where(
      and(
        inArray(subscriptions.status, ["active", "past_due"]),
        lte(subscriptions.currentPeriodEnd, now),
        eq(subscriptions.cancelAtPeriodEnd, false),
      ),
    )
    .limit(limit);
}

/**
 * Cancels at period end by default.
 *
 * Immediate cancellation is available but is not the default: the customer has
 * already paid for the period, and cutting them off creates a refund obligation
 * in exchange for nothing.
 */
export async function cancelSubscription(args: {
  subscriptionId: string;
  immediate?: boolean;
  now?: Date;
}) {
  const now = args.now ?? new Date();
  const [updated] = await db
    .update(subscriptions)
    .set(
      args.immediate
        ? { status: "canceled", canceledAt: now, cancelAtPeriodEnd: false, updatedAt: now }
        : { cancelAtPeriodEnd: true, updatedAt: now },
    )
    .where(eq(subscriptions.id, args.subscriptionId))
    .returning();
  return updated ?? null;
}

/** Ends subscriptions that asked to stop and whose paid period has now run out. */
export async function sweepCancellations(now = new Date()) {
  const rows = await db
    .update(subscriptions)
    .set({ status: "canceled", canceledAt: now, updatedAt: now })
    .where(
      and(
        eq(subscriptions.cancelAtPeriodEnd, true),
        inArray(subscriptions.status, ["active", "past_due"]),
        lte(subscriptions.currentPeriodEnd, now),
      ),
    )
    .returning({ id: subscriptions.id });
  return rows.length;
}

/**
 * What AdVault has actually earned, from the ledger.
 *
 * Sums `fee` rows rather than invoices, because the ledger is the authoritative
 * record and a paid invoice with no matching ledger row would be a bug this
 * query should surface rather than hide.
 */
export async function revenueTotals(): Promise<
  { currencyCode: string; feeMinor: number; payingCustomers: number }[]
> {
  const rows = await db
    .select({
      currencyCode: subscriptions.currencyCode,
      payingCustomers: sql<number>`count(distinct ${subscriptions.userId})::int`,
      feeMinor: sql<number>`coalesce(sum(${subscriptions.amountMinor}), 0)::int`,
    })
    .from(subscriptions)
    .where(inArray(subscriptions.status, ["active", "past_due"]))
    .groupBy(subscriptions.currencyCode);

  return rows.map((r) => ({
    currencyCode: r.currencyCode,
    feeMinor: Number(r.feeMinor ?? 0),
    payingCustomers: Number(r.payingCustomers ?? 0),
  }));
}

export async function userCurrency(userId: string): Promise<Currency> {
  const [u] = await db
    .select({ currencyCode: users.currencyCode })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return (u?.currencyCode as Currency) ?? "USD";
}

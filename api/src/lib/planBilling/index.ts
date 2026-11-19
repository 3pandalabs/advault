import { and, desc, eq, inArray, isNotNull, or } from "drizzle-orm";
import { db } from "../../db/index.js";
import { campaigns, subscriptions, users } from "../../db/schema.js";
import { notifyOps } from "../ops/notify.js";
import {
  buysMedia,
  MIN_MONTHLY_AD_BUDGET_MINOR,
  monthlyAdBudgetProblem,
  planByKey,
  type Currency,
  type Plan,
  type ProductLine,
} from "../pricing/index.js";
import { billingModeFor, createSubscription, liveSubscriptionFor, markInvoicePaid, userCurrency } from "../subscriptions/index.js";
import { subscriptionProviderFor } from "../subscriptions/providers/index.js";
import {
  StripeApiError,
  stripeCancelNow,
  stripeRestartOffSession,
  stripeSessionRefs,
  stripeSetCancelAtPeriodEnd,
  stripeSetAdBudgetQuantity,
  stripeSubscriptions,
} from "../subscriptions/providers/stripe.js";
import { billingIdentity } from "../testMode/index.js";
import { syncSitePlanCover } from "../sitePlanCover/index.js";
import {
  adWantsPlan,
  isRunning,
  PLAN_FOLLOWS_RUNNING_LINE,
  planAllowsRunning,
  planBillingAction,
  planGate,
  planTerms,
  type PlanBillingAction,
  type PlanGate,
  type PlanSub,
  type PlanTerms,
} from "./policy.js";

// The plan follows the running ad (owner decision 2026-11-19, option B).
// The pure rules are in ./policy.ts. This is the database and Stripe side.
//
//   syncPlanBillingForUser(userId)   THE one place that moves the plan to
//       match the ads: stop at period end when nothing runs, un-stop when an
//       ad runs again inside a paid period, restart (off-session, saved card)
//       when an ad runs and the period is over. Idempotent; call it after
//       anything that changes whether an ad runs: launch, pause, resume, a
//       top-up that restarted a campaign. The API sweep (every 10 min) also
//       runs it for everyone, which covers what the renderer changes on its
//       own (pause for an empty budget, end dates, auto-restart), because the
//       renderer holds no Stripe key.
//   planGateFor / ensurePlanForRunning   the launch and resume gate.
//
// Only the API process calls Stripe from here.

function log(msg: string, extra?: unknown): void {
  console.log(JSON.stringify({ job: "plan-billing", msg, extra: extra ?? undefined }));
}

const DEFAULT_PLAN_KEY: Partial<Record<Currency, string>> = { USD: "us-evergreen" };

const todayIso = (now: Date) => now.toISOString().slice(0, 10);

/** Does this user have an ad running at Google right now? */
export async function hasRunningAd(userId: string, now = new Date()): Promise<boolean> {
  const rows = await db
    .select({
      status: campaigns.status,
      googleCampaignResourceName: campaigns.googleCampaignResourceName,
      endsOn: campaigns.endsOn,
    })
    .from(campaigns)
    .where(and(eq(campaigns.userId, userId), eq(campaigns.status, "live"), isNotNull(campaigns.googleCampaignResourceName)));
  return rows.some((c) => isRunning(c, todayIso(now)));
}

/**
 * An ad paused ONLY because its budget ran out (spendSync), launched and not
 * past its end date: on a plan with a monthly recharge, the next paid month
 * refills the budget and switches it back on.
 */
export async function hasAdWaitingForBudget(userId: string, now = new Date()): Promise<boolean> {
  const rows = await db
    .select({ endsOn: campaigns.endsOn })
    .from(campaigns)
    .where(
      and(
        eq(campaigns.userId, userId),
        eq(campaigns.status, "paused"),
        isNotNull(campaigns.pausedForFundsAt),
        isNotNull(campaigns.googleCampaignResourceName),
      ),
    );
  return rows.some((c) => !c.endsOn || c.endsOn >= todayIso(now));
}

/**
 * The terms a NEW plan subscription for this user starts on ("$55 a month",
 * policy.ts planTerms): $20 + the chosen monthly ad budget (default and
 * minimum $35; no recharge when Google bills the customer's own card; 50
 * cents each in test mode). The caller validates `chosenBudgetMinor`.
 */
export async function planTermsFor(
  userId: string,
  plan: Plan,
  who: { testMode: boolean },
  chosenBudgetMinor?: number | null,
): Promise<PlanTerms> {
  return planTerms({
    line: plan.line,
    listFeeMinor: plan.monthlyFeeMinor,
    rechargeMinor: MIN_MONTHLY_AD_BUDGET_MINOR[plan.currency] ? (chosenBudgetMinor ?? MIN_MONTHLY_AD_BUDGET_MINOR[plan.currency]!) : 0,
    billingMode: await billingModeFor(userId),
    testMode: who.testMode,
  });
}

async function firstMonthUsed(userId: string): Promise<boolean> {
  const [u] = await db
    .select({ at: users.planFirstMonthUsedAt })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return !!u?.at;
}

/** Has this account still got its included first month? */
export async function firstMonthAvailable(userId: string): Promise<boolean> {
  return !(await firstMonthUsed(userId));
}

type SubRow = typeof subscriptions.$inferSelect;

const asPlanSub = (s: SubRow | null): PlanSub =>
  s ? { line: s.line, status: s.status, cancelAtPeriodEnd: s.cancelAtPeriodEnd, currentPeriodEnd: s.currentPeriodEnd } : null;

/** The launch / resume gate, without side effects. */
export async function planGateFor(userId: string, now = new Date()): Promise<PlanGate> {
  const who = await billingIdentity(userId);
  const sub = await liveSubscriptionFor(userId);
  return planGate({
    exempt: who.exempt,
    sub: asPlanSub(sub),
    firstMonthUsed: await firstMonthUsed(userId),
    buysMedia: (line) => buysMedia(line as ProductLine),
    now,
  });
}

/** May an automatic restart (a top-up) switch an ad back on? DB only (the renderer calls it). */
export async function planAllowsRunningFor(userId: string, now = new Date()): Promise<boolean> {
  const who = await billingIdentity(userId);
  return planAllowsRunning({ exempt: who.exempt, sub: asPlanSub(await liveSubscriptionFor(userId)), now });
}

/**
 * The gate for something about to make an ad run (launch, resume, a top-up
 * restart). When the plan has stopped and the included month is spent, it
 * first tries to restart the plan off-session with the saved card; only if
 * that is impossible does it answer plan_required (the caller sends the
 * customer to checkout).
 */
export async function ensurePlanForRunning(userId: string, now = new Date()): Promise<PlanGate & { restarted?: boolean }> {
  const gate = await planGateFor(userId, now);
  if (gate.ok || gate.error !== "plan_required" || gate.firstMonthIncluded) return gate;
  const r = await restartPlanOffSession(userId, now);
  if (r.ok) return { ok: true, restarted: true };
  return gate;
}

/** The Stripe sub_ for a row, resolving (and storing) it from the checkout session for older rows. */
async function stripeRefFor(sub: SubRow): Promise<string | null> {
  if (sub.provider !== "stripe") return null;
  if (sub.providerSubscriptionRef) return sub.providerSubscriptionRef;
  if (!sub.providerRef || !sub.providerRef.startsWith("cs_")) return null;
  try {
    const refs = await stripeSessionRefs(sub.providerRef);
    if (!refs.subscription) return null;
    await db
      .update(subscriptions)
      .set({ providerSubscriptionRef: refs.subscription, providerCustomerRef: refs.customer ?? sub.providerCustomerRef })
      .where(eq(subscriptions.id, sub.id));
    return refs.subscription;
  } catch (err) {
    log("could not resolve the Stripe subscription from its checkout session", { subscriptionId: sub.id, error: String(err) });
    return null;
  }
}

const stripeLive = () => stripeSubscriptions.isConfigured();

async function setCancelLocal(subId: string, cancel: boolean): Promise<void> {
  await db.update(subscriptions).set({ cancelAtPeriodEnd: cancel, updatedAt: new Date() }).where(eq(subscriptions.id, subId));
}

/** Stop at the end of the paid period. Returns false when Stripe could not be told (retried next sweep). */
async function stopAtPeriodEnd(sub: SubRow): Promise<boolean> {
  if (sub.provider === "stripe" && stripeLive()) {
    const ref = await stripeRefFor(sub);
    if (!ref) {
      log("no Stripe subscription id to stop", { subscriptionId: sub.id });
      return false;
    }
    try {
      await stripeSetCancelAtPeriodEnd(ref, true);
    } catch (err) {
      log("Stripe refused cancel_at_period_end", { subscriptionId: sub.id, error: String(err) });
      return false;
    }
  }
  await setCancelLocal(sub.id, true);
  return true;
}

/** Take a stop back inside the paid period. "gone" = Stripe already ended it. */
async function uncancel(sub: SubRow): Promise<"ok" | "gone" | "failed"> {
  if (sub.provider === "stripe" && stripeLive()) {
    const ref = await stripeRefFor(sub);
    if (!ref) return "failed";
    try {
      const s = await stripeSetCancelAtPeriodEnd(ref, false);
      if (s.status === "canceled" || s.status === "incomplete_expired") return "gone";
    } catch (err) {
      if (err instanceof StripeApiError && (err.status === 400 || err.status === 404)) return "gone";
      log("Stripe refused to un-cancel", { subscriptionId: sub.id, error: String(err) });
      return "failed";
    }
  }
  await setCancelLocal(sub.id, false);
  return "ok";
}

export type AdBudgetChange =
  | { ok: true; budgetRechargeMinor: number; effectiveFrom: Date | null; testMode: boolean }
  | {
      ok: false;
      error:
        | "no_subscription"
        | "no_monthly_budget"
        | "plan_pending"
        | "stripe_error"
        | "budget_below_minimum"
        | "budget_not_whole_dollars"
        | "budget_too_large";
      minMinor?: number;
    };

/**
 * "From $55 a month": change the customer's monthly ad budget on their live
 * plan. Whole dollars, at least $35. No proration: the Stripe budget item's
 * quantity changes with `proration_behavior=none`, so it applies from the
 * next invoice and nothing is charged or refunded now; the invoice already
 * paid keeps the amount it charged (and credited). Raising, lowering and
 * keeping the minimum all work. Test mode (admin testing as a customer)
 * keeps charging the 50-cent test unit: the request is validated, nothing
 * changes.
 */
export async function changeMonthlyAdBudget(userId: string, amountMinor: number): Promise<AdBudgetChange> {
  const sub = await liveSubscriptionFor(userId);
  if (!sub) return { ok: false, error: "no_subscription" };
  if (sub.line !== PLAN_FOLLOWS_RUNNING_LINE || sub.budgetRechargeMinor <= 0) return { ok: false, error: "no_monthly_budget" };
  const problem = monthlyAdBudgetProblem(amountMinor, sub.currencyCode as Currency);
  if (problem) return { ok: false, error: problem.error === "no_monthly_budget" ? "no_monthly_budget" : problem.error, minMinor: problem.minMinor };

  const who = await billingIdentity(userId);
  if (who.testMode) {
    return { ok: true, budgetRechargeMinor: sub.budgetRechargeMinor, effectiveFrom: sub.currentPeriodEnd, testMode: true };
  }
  if (sub.budgetRechargeMinor !== amountMinor) {
    const ref = await stripeRefFor(sub);
    if (!ref) return { ok: false, error: "plan_pending" };
    try {
      const r = await stripeSetAdBudgetQuantity(ref, amountMinor);
      if (!r.ok) {
        log("monthly ad budget change: no budget line on the Stripe subscription", { userId, subscriptionId: sub.id });
        return { ok: false, error: "stripe_error" };
      }
    } catch (err) {
      log("monthly ad budget change failed", { userId, error: String(err) });
      return { ok: false, error: "stripe_error" };
    }
    // Invoices opened from now on carry the new amount (openNextInvoice).
    await db.update(subscriptions).set({ budgetRechargeMinor: amountMinor }).where(eq(subscriptions.id, sub.id));
  }
  return { ok: true, budgetRechargeMinor: amountMinor, effectiveFrom: sub.currentPeriodEnd, testMode: false };
}

export type RestartResult =
  | { ok: true; budgetCreditedMinor?: number }
  | { ok: false; reason: "exempt" | "checkout_required" | "no_saved_card" | "card_declined" | "stripe_error" | "already_live" };

/**
 * Starts a new plan period now, charged to the card the last plan used.
 *
 * Never for the included month (that is a $0 Stripe trial the customer starts
 * at checkout), never without a previous Stripe subscription to take the card
 * from. The local row is created first so the one-live-subscription index
 * stops a double restart; a failed charge cancels it again.
 */
export async function restartPlanOffSession(userId: string, now = new Date()): Promise<RestartResult> {
  const who = await billingIdentity(userId);
  if (who.exempt) return { ok: false, reason: "exempt" };
  if (!(await firstMonthUsed(userId))) return { ok: false, reason: "checkout_required" };
  if (await liveSubscriptionFor(userId)) return { ok: false, reason: "already_live" };

  const currency = await userCurrency(userId);
  const [prev] = await db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.userId, userId),
        eq(subscriptions.provider, "stripe"),
        eq(subscriptions.line, PLAN_FOLLOWS_RUNNING_LINE),
        or(isNotNull(subscriptions.providerSubscriptionRef), isNotNull(subscriptions.providerRef)),
      ),
    )
    .orderBy(desc(subscriptions.createdAt))
    .limit(1);
  const planKey = prev?.planKey ?? DEFAULT_PLAN_KEY[currency];
  const plan = planKey ? planByKey(planKey) : null;
  if (!plan || !prev) return { ok: false, reason: "checkout_required" };
  const provider = subscriptionProviderFor(plan.currency, plan.line);
  if (provider.name !== "stripe") return { ok: false, reason: "checkout_required" };
  const prevRef = await stripeRefFor(prev);
  if (!prevRef) return { ok: false, reason: "no_saved_card" };

  // The restart keeps the monthly ad budget the customer chose last time.
  const terms = await planTermsFor(userId, plan, who, prev.budgetRechargeMinor >= (MIN_MONTHLY_AD_BUDGET_MINOR[plan.currency] ?? Infinity) ? prev.budgetRechargeMinor : null);
  const amountMinor = terms.feeMinor;
  const budgetMinor = terms.budgetRechargeMinor;
  let created;
  try {
    created = await createSubscription({
      userId,
      planKey: plan.key,
      provider: "stripe",
      amountMinor,
      budgetRechargeMinor: budgetMinor,
      now,
    });
  } catch {
    return { ok: false, reason: "already_live" };
  }

  const r = await stripeRestartOffSession({
    previousSubscriptionRef: prevRef,
    planKey: plan.key,
    testMode: who.testMode,
    amountMinor,
    currency: plan.currency,
    subscriptionId: created.subscription.id,
    invoiceId: created.invoice.id,
    internal: who.internal,
    internalLabel: who.internalLabel,
    budgetMinor,
  });
  if (!r.ok) {
    await db
      .update(subscriptions)
      .set({ status: "canceled", canceledAt: new Date(), updatedAt: new Date() })
      .where(eq(subscriptions.id, created.subscription.id));
    log("off-session plan restart failed", { userId, reason: r.reason, detail: r.detail });
    return { ok: false, reason: r.reason };
  }

  await db
    .update(subscriptions)
    .set({ providerRef: r.subscriptionRef, providerSubscriptionRef: r.subscriptionRef, providerCustomerRef: r.customerRef })
    .where(eq(subscriptions.id, created.subscription.id));
  if (r.amountPaidMinor !== amountMinor + budgetMinor) {
    log("restart charged a different amount than the invoice", { userId, expected: amountMinor + budgetMinor, got: r.amountPaidMinor });
  }
  // Same external ref the invoice.paid webhook will carry, so that copy is a duplicate.
  const paid = await markInvoicePaid({
    invoiceId: created.invoice.id,
    externalRef: `stripe:${r.invoiceRef ?? r.subscriptionRef}`,
    providerPayload: { restartedOffSession: true },
    providerSubscriptionRef: r.subscriptionRef,
    providerCustomerRef: r.customerRef,
  });
  log("plan restarted off-session", { userId, subscriptionId: created.subscription.id });
  return { ok: true, budgetCreditedMinor: paid.budgetCreditedMinor };
}

// One sync per user at a time in this process (launch + sweep racing). The
// one-live-subscription index is the cross-process guarantee for restarts;
// stop / un-stop are idempotent at Stripe.
const inflight = new Map<string, Promise<PlanSyncResult>>();
const alertedAt = new Map<string, number>();

export type PlanSyncResult = { action: PlanBillingAction["kind"]; ok: boolean; reason?: string };

/** Make the plan match whether any ad runs. Idempotent, never throws. */
export function syncPlanBillingForUser(userId: string, now = new Date()): Promise<PlanSyncResult> {
  const prior = inflight.get(userId) ?? Promise.resolve(null);
  const next = prior
    .catch(() => null)
    .then(() => syncOnce(userId, now))
    .catch((err): PlanSyncResult => {
      log("plan sync threw", { userId, error: String(err) });
      return { action: "none", ok: false, reason: "threw" };
    });
  inflight.set(userId, next);
  void next.finally(() => {
    if (inflight.get(userId) === next) inflight.delete(userId);
  });
  return next;
}

async function syncOnce(userId: string, now: Date): Promise<PlanSyncResult> {
  const who = await billingIdentity(userId);
  const sub = await liveSubscriptionFor(userId);
  // "$55 a month": on a plan with a monthly budget recharge, an ad paused only
  // because its budget ran out keeps the plan going, so the next month's
  // recharge refills the budget and switches it back on (policy adWantsPlan).
  const planRecharges = (sub?.budgetRechargeMinor ?? 0) > 0;
  const running = adWantsPlan({
    running: await hasRunningAd(userId, now),
    waitingForBudget: planRecharges && (await hasAdWaitingForBudget(userId, now)),
    planRecharges,
  });
  const action = planBillingAction({ exempt: who.exempt, running, sub: asPlanSub(sub), now });

  switch (action.kind) {
    case "none":
      return { action: "none", ok: true, reason: action.reason };
    case "stop_at_period_end": {
      const ok = await stopAtPeriodEnd(sub!);
      if (ok) log("no ad running: plan stops at period end", { userId, until: sub!.currentPeriodEnd });
      return { action: action.kind, ok };
    }
    case "uncancel": {
      const r = await uncancel(sub!);
      if (r === "ok") {
        log("ad running again inside the paid period: plan un-stopped", { userId });
        return { action: "uncancel", ok: true };
      }
      if (r === "failed") return { action: "uncancel", ok: false };
      // Stripe already ended it: end ours too, then start a new period.
      await db
        .update(subscriptions)
        .set({ status: "canceled", canceledAt: now, updatedAt: now })
        .where(eq(subscriptions.id, sub!.id));
      return restartAndReport(userId, now);
    }
    case "restart":
      if (sub) {
        // A stopping plan whose period ran out before the sweep ended it.
        await db
          .update(subscriptions)
          .set({ status: "canceled", canceledAt: now, updatedAt: now })
          .where(and(eq(subscriptions.id, sub.id), inArray(subscriptions.status, ["active", "past_due"])));
      }
      return restartAndReport(userId, now);
  }
}

async function restartAndReport(userId: string, now: Date): Promise<PlanSyncResult> {
  const r = await restartPlanOffSession(userId, now);
  if (r.ok) {
    // The new month's ad budget landed: unfreeze and switch back on what an
    // empty budget paused. Not awaited: it runs its own plan sync, which
    // queues behind this one.
    if ((r.budgetCreditedMinor ?? 0) > 0) {
      void import("./resume.js").then((m) => m.afterPlanBudgetCredit(userId));
    }
    return { action: "restart", ok: true };
  }
  // An ad runs with no plan and no way to charge for it (no saved card, a
  // decline). Launch and resume refuse this; it can only come from a renewal
  // that failed dunning. Tell ops at most once a day per customer.
  const last = alertedAt.get(userId) ?? 0;
  if (Date.now() - last > 24 * 3600_000) {
    alertedAt.set(userId, Date.now());
    await notifyOps({
      title: "AdVault: ad running without a plan",
      message: `User ${userId} has a running ad and no paid plan; restarting the plan failed (${r.reason}).`,
      priority: 3,
      tags: ["moneybag"],
    }).catch(() => undefined);
  }
  return { action: "restart", ok: false, reason: r.reason };
}

/** Everyone whose plan might need to move: a live evergreen plan, or a live campaign. */
export async function syncAllPlanBilling(now = new Date()): Promise<Record<string, number>> {
  const withPlan = await db
    .selectDistinct({ userId: subscriptions.userId })
    .from(subscriptions)
    .where(and(eq(subscriptions.line, PLAN_FOLLOWS_RUNNING_LINE), inArray(subscriptions.status, ["active", "past_due"])));
  const withLive = await db
    .selectDistinct({ userId: campaigns.userId })
    .from(campaigns)
    .where(and(eq(campaigns.status, "live"), isNotNull(campaigns.googleCampaignResourceName)));
  const ids = new Set([...withPlan, ...withLive].map((r) => r.userId));
  const counts: Record<string, number> = {};
  for (const id of ids) {
    const r = await syncPlanBillingForUser(id, now);
    if (r.action !== "none") counts[`${r.action}:${r.ok ? "ok" : "failed"}`] = (counts[`${r.action}:${r.ok ? "ok" : "failed"}`] ?? 0) + 1;
  }
  // "$55 a month": the AdVault-made website stays on Pro while the plan runs.
  for (const { userId } of withPlan) {
    const c = await syncSitePlanCover(userId, now);
    if (c === "pushed" || c === "failed") counts[`siteCover:${c}`] = (counts[`siteCover:${c}`] ?? 0) + 1;
  }
  return counts;
}

/** Every 10 minutes in the API (the only process holding the Stripe key). */
export function startPlanBillingSweep(intervalMs = 10 * 60 * 1000): void {
  const tick = () =>
    syncAllPlanBilling()
      .then((r) => {
        if (Object.keys(r).length > 0) log("sweep", r);
      })
      .catch((err) => log("sweep threw", String(err)));
  setInterval(tick, intervalMs).unref();
}

/** Account deletion: end the user's Stripe plan now (the local row is cancelled in the deletion transaction). */
export async function endStripePlansNow(userId: string): Promise<void> {
  if (!stripeLive()) return;
  const rows = await db
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.userId, userId), eq(subscriptions.provider, "stripe")))
    .orderBy(desc(subscriptions.createdAt))
    .limit(5);
  for (const s of rows) {
    const ref = await stripeRefFor(s);
    if (!ref) continue;
    await stripeCancelNow(ref).catch((err) => {
      // Already canceled answers 404/400: fine.
      if (!(err instanceof StripeApiError && (err.status === 404 || err.status === 400))) {
        log("could not cancel a Stripe plan on account deletion", { userId, error: String(err) });
      }
    });
  }
}

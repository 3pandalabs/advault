// Every pure decision about a subscription lives here.
//
// Same reason `lib/billing/policy.ts` exists: this is the part of the money
// path that needs neither a live Postgres nor a provider account, so it is the
// part that can actually be tested. Anything here that reaches for `db` or
// `fetch` belongs in ./index.ts instead.

import type { BillingMode } from "../billing/policy.js";
import type { ProductLine } from "../pricing/index.js";

export type SubscriptionStatus = "pending" | "active" | "past_due" | "canceled" | "expired";

// ---------------------------------------------------------------------------
// Period arithmetic.
// ---------------------------------------------------------------------------

/**
 * One month on from `from`, clamped to the last day of the target month.
 *
 * The naive `setMonth(m + 1)` overflows: 31 January + 1 month lands on 3 March
 * in a non-leap year, which silently gives the customer two extra billing days
 * and then bills them on the 3rd forever. Clamping keeps a 31st-of-the-month
 * subscriber anchored to month ends instead of drifting.
 */
export function addMonth(from: Date): Date {
  const d = new Date(from.getTime());
  const targetMonth = d.getUTCMonth() + 1;
  const anchorDay = d.getUTCDate();

  d.setUTCDate(1);
  d.setUTCMonth(targetMonth);

  const daysInTarget = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
  ).getUTCDate();
  d.setUTCDate(Math.min(anchorDay, daysInTarget));
  return d;
}

/** First instant of the month containing `at`, UTC. The offer-cycle key. */
export function monthStart(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
}

export type Period = { start: Date; end: Date };

export function firstPeriod(startingAt: Date): Period {
  return { start: startingAt, end: addMonth(startingAt) };
}

/**
 * The period after `current`.
 *
 * Anchored to the previous period's END, never to "now". Anchoring to now would
 * let every retry, outage or late webhook push the renewal date forward, and a
 * subscriber who fails a charge on the 3rd would slowly migrate to being billed
 * on the 20th.
 */
export function nextPeriod(current: Period): Period {
  return { start: current.end, end: addMonth(current.end) };
}

/** Has this period ended as of `now`? */
export function isDue(period: Period, now: Date): boolean {
  return period.end.getTime() <= now.getTime();
}

// ---------------------------------------------------------------------------
// Dunning.
//
// A failed card is overwhelmingly a temporary condition — an expired card, a
// daily limit, a bank's fraud heuristic — not a customer who has left. Cutting
// service off on the first failure loses people who fully intended to pay, and
// for a WhatsApp-driven product the recovery conversation is cheap. So service
// continues through a grace window while we retry, and only then stops.
//
// The counterweight: a subscriber who never pays is a subscriber we are
// producing videos for at our own vendor cost. GRACE_DAYS is bounded for that
// reason, not because the retries stop being useful.
// ---------------------------------------------------------------------------

export const MAX_CHARGE_ATTEMPTS = 4;
export const GRACE_DAYS = 10;

/** Days after a failure before the next retry. Widening, then give up. */
const RETRY_BACKOFF_DAYS = [1, 3, 5];

export type DunningDecision =
  | { action: "retry"; nextAttemptAt: Date; keepServing: true }
  | { action: "expire"; keepServing: false };

export function dunningDecision(args: {
  failedChargeCount: number;
  firstFailureAt: Date;
  now: Date;
}): DunningDecision {
  const graceEnd = new Date(args.firstFailureAt.getTime() + GRACE_DAYS * 86_400_000);
  const outOfAttempts = args.failedChargeCount >= MAX_CHARGE_ATTEMPTS;
  const outOfTime = args.now.getTime() >= graceEnd.getTime();

  if (outOfAttempts || outOfTime) return { action: "expire", keepServing: false };

  const backoff =
    RETRY_BACKOFF_DAYS[Math.min(args.failedChargeCount, RETRY_BACKOFF_DAYS.length) - 1] ??
    RETRY_BACKOFF_DAYS[0];
  return {
    action: "retry",
    nextAttemptAt: new Date(args.now.getTime() + backoff * 86_400_000),
    keepServing: true,
  };
}

/**
 * Does a subscription in this state entitle the customer to service?
 *
 * `past_due` deliberately DOES. That is the whole point of a grace window, and
 * it is also why expiry has to be enforced somewhere — an unbounded past_due is
 * a free customer.
 */
export function entitlesToService(status: SubscriptionStatus): boolean {
  return status === "active" || status === "past_due";
}

// ---------------------------------------------------------------------------
// Where the fee money comes from.
//
// Platform revenue is ALWAYS recorded as a `fee` ledger entry, whatever rail
// collected it. That is what makes "what did AdVault earn" one query over one
// column instead of a union across provider tables.
//
// But the ledger is a wallet, and a wallet cannot go negative. So the funding
// source decides whether the fee needs a matching credit posted alongside it:
//
//   'wallet'   — platform-billed managed accounts prepay an all-in amount
//                (₹3,499 = ₹2,000 spend + ₹1,499 fee) into the wallet. The fee
//                is drawn from a balance that is already there. No credit.
//   'external' — the offer line and customer-billed managed accounts are
//                charged directly on a card, UPI mandate or through the
//                merchant of record. That money never sits in the wallet, so a
//                paired `topup` credit is posted with the fee and the two net
//                to zero. The balance is unchanged; the revenue is recorded.
//
// Getting this backwards is expensive in both directions: a missing credit
// makes an offer-line fee fail with insufficient_funds for a customer whose
// card just succeeded, and a spurious credit hands a platform-billed advertiser
// free ad budget every month.
// ---------------------------------------------------------------------------

export type FeeFunding = "wallet" | "external";

export function feeFunding(line: ProductLine, billingMode: BillingMode | null): FeeFunding {
  if (line === "offer") return "external";
  return billingMode === "platform" ? "wallet" : "external";
}

/**
 * Idempotency keys for the ledger rows a paid invoice produces.
 *
 * Derived from our own invoice id rather than the provider's, because the same
 * invoice can be retried across providers (a failed Razorpay mandate re-charged
 * manually, say) and must still post exactly once. The `:fee` suffix keeps the
 * two rows of an external-funded pair distinct under the partial unique index
 * on (wallet_id, external_ref) — without it the second insert collides with the
 * first and the fee silently never lands.
 */
export function feeLedgerRefs(invoiceId: string): { credit: string; fee: string } {
  return { credit: `subinv:${invoiceId}`, fee: `subinv:${invoiceId}:fee` };
}

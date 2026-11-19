// The $19 plan follows the running ad (owner decision 2026-11-19, option B).
//
//   "$19 a month while your ad is running. Pause anytime: no fee while paused."
//   First month included with the first ad, once per account.
//
// Every pure decision lives here and is tested (policy.test.ts); ./index.ts is
// the database and Stripe side. Read the "Plan follows the running ad" section
// of CLAUDE.md first.

import type { SubscriptionStatus } from "../subscriptions/policy.js";

/** The only line whose fee follows the running ad. Others keep their old lifecycle. */
export const PLAN_FOLLOWS_RUNNING_LINE = "evergreen";

export type PlanCampaign = {
  status: string;
  googleCampaignResourceName: string | null;
  /** campaigns.ends_on, "yyyy-mm-dd" (Google stops the campaign at the end of that day). */
  endsOn: string | null;
};

/**
 * Is this campaign running (spending at Google) right now?
 *
 * live AND launched AND not past its end date. Our status stays `live` after
 * Google ends a campaign on its ends_on (run_days, PR #124), so the end date
 * is read here instead of asking Google: ends_on is the UTC date launch sent,
 * and Google stops at 23:59:59 in the account's (US) time zone, the same day
 * or later, so "ended" is never declared while the paid period still has an
 * ad in it for long (at most a few hours, in the customer's favour).
 * Paused for any reason (by the customer, empty budget, offer expiry,
 * account deletion) is not running.
 */
export function isRunning(c: PlanCampaign, todayIso: string): boolean {
  if (c.status !== "live" || !c.googleCampaignResourceName) return false;
  return !c.endsOn || c.endsOn >= todayIso;
}

export type PlanSub = {
  line: string;
  status: SubscriptionStatus | string;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: Date | null;
} | null;

/** Is the plan paid up for the current moment (a period that has not run out)? */
export function planCoversNow(sub: PlanSub, now: Date): boolean {
  if (!sub) return false;
  if (sub.status !== "active" && sub.status !== "past_due") return false;
  // A stopping plan serves out what was paid for, and no longer.
  if (sub.cancelAtPeriodEnd) return !!sub.currentPeriodEnd && sub.currentPeriodEnd.getTime() > now.getTime();
  return true;
}

export type PlanBillingAction =
  | { kind: "none"; reason: string }
  /** No ad running: stop at the end of the paid period (Stripe cancel_at_period_end). */
  | { kind: "stop_at_period_end" }
  /** An ad runs again inside a paid period that was stopping: take the stop back, no charge. */
  | { kind: "uncancel" }
  /** An ad runs and there is no paid period: start a new one (charged now). */
  | { kind: "restart" };

/**
 * What the plan should do given whether any ad runs. Idempotent: applying the
 * action and asking again answers "none".
 */
export function planBillingAction(args: {
  /** Admins (not testing as a customer) and at_cost accounts pay no plan. */
  exempt: boolean;
  running: boolean;
  sub: PlanSub;
  now: Date;
}): PlanBillingAction {
  const { sub, running, now } = args;
  if (args.exempt) return { kind: "none", reason: "exempt" };
  if (sub && sub.line !== PLAN_FOLLOWS_RUNNING_LINE) return { kind: "none", reason: "other_line" };
  // A checkout is open; its webhook decides.
  if (sub?.status === "pending") return { kind: "none", reason: "checkout_in_progress" };
  const live = !!sub && (sub.status === "active" || sub.status === "past_due");

  if (!running) {
    if (live && !sub!.cancelAtPeriodEnd) return { kind: "stop_at_period_end" };
    return { kind: "none", reason: live ? "already_stopping" : "no_plan" };
  }

  if (live && !sub!.cancelAtPeriodEnd) return { kind: "none", reason: "running_and_billing" };
  if (live && planCoversNow(sub, now)) return { kind: "uncancel" };
  return { kind: "restart" };
}

/**
 * The launch / resume gate.
 *
 * - `ok`: exempt, or a plan that buys media covers now (a stopping plan
 *   counts: the caller then un-stops it, no second charge).
 * - `plan_has_no_ads`: a plan that only makes videos.
 * - `plan_pending`: a plan checkout was just completed and its webhook has not
 *   landed (seconds); try again.
 * - `plan_required`: start or restart the plan. `firstMonthIncluded` = this
 *   account has never used its included month: the plan checkout charges $0
 *   today (Stripe trial) and the first $19 a month later, and only if an ad
 *   is still running then. Otherwise the caller tries an off-session restart
 *   with the saved card before answering this.
 */
export type PlanGate =
  | { ok: true }
  | { ok: false; error: "plan_has_no_ads" | "plan_pending" }
  | { ok: false; error: "plan_required"; firstMonthIncluded: boolean };

export function planGate(args: {
  exempt: boolean;
  sub: PlanSub;
  firstMonthUsed: boolean;
  buysMedia: (line: string) => boolean;
  now: Date;
}): PlanGate {
  if (args.exempt) return { ok: true };
  const { sub } = args;
  if (sub && planCoversNow(sub, args.now)) {
    return args.buysMedia(sub.line) ? { ok: true } : { ok: false, error: "plan_has_no_ads" };
  }
  if (sub?.status === "pending") return { ok: false, error: "plan_pending" };
  return { ok: false, error: "plan_required", firstMonthIncluded: !args.firstMonthUsed };
}

/** May an automatic restart (top-up) switch an ad back on? Only with a plan that covers now. */
export function planAllowsRunning(args: { exempt: boolean; sub: PlanSub; now: Date }): boolean {
  return args.exempt || planCoversNow(args.sub, args.now);
}

/** The 402 body for a refused gate (launch and resume answer the same shape). */
export function planGateBody(gate: Exclude<PlanGate, { ok: true }>): Record<string, unknown> {
  if (gate.error === "plan_required") {
    return {
      error: "plan_required",
      firstMonthIncluded: gate.firstMonthIncluded,
      detail: gate.firstMonthIncluded
        ? "Start your AdVault plan: $0 today, your first month is included. Then $19 a month while your ad runs."
        : "Restart your AdVault plan: $19 a month while your ad runs. Pause anytime: no fee while paused.",
    };
  }
  if (gate.error === "plan_pending") {
    return { error: "plan_pending", detail: "We're confirming your plan. Try again in a few seconds." };
  }
  return { error: gate.error };
}

import { describe, expect, it } from "vitest";
import {
  adWantsPlan,
  isRunning,
  planAllowsRunning,
  planBillingAction,
  planGate,
  planGateBody,
  planTerms,
  type PlanSub,
} from "./policy.js";

const now = new Date("2026-11-19T12:00:00Z");
const later = new Date("2026-12-19T12:00:00Z");
const earlier = new Date("2026-11-01T00:00:00Z");
const sub = (over: Partial<NonNullable<PlanSub>> = {}): PlanSub => ({
  line: "evergreen",
  status: "active",
  cancelAtPeriodEnd: false,
  currentPeriodEnd: later,
  ...over,
});
const buysMedia = (line: string) => line !== "offer";

describe("isRunning", () => {
  const live = { status: "live", googleCampaignResourceName: "customers/1/campaigns/2", endsOn: null };
  it("is live, launched and not past its end date", () => {
    expect(isRunning(live, "2026-11-19")).toBe(true);
    expect(isRunning({ ...live, endsOn: "2026-11-19" }, "2026-11-19")).toBe(true);
    expect(isRunning({ ...live, endsOn: "2026-11-18" }, "2026-11-19")).toBe(false);
  });
  it("is not running when paused (any reason), never launched or draft", () => {
    expect(isRunning({ ...live, status: "paused" }, "2026-11-19")).toBe(false);
    expect(isRunning({ ...live, googleCampaignResourceName: null }, "2026-11-19")).toBe(false);
    expect(isRunning({ ...live, status: "ready" }, "2026-11-19")).toBe(false);
  });
});

describe("planBillingAction", () => {
  const act = (running: boolean, s: PlanSub, exempt = false) => planBillingAction({ exempt, running, sub: s, now }).kind;

  it("stops at period end when no ad runs, once", () => {
    expect(act(false, sub())).toBe("stop_at_period_end");
    expect(act(false, sub({ cancelAtPeriodEnd: true }))).toBe("none");
    expect(act(false, sub({ status: "past_due" }))).toBe("stop_at_period_end");
    expect(act(false, null)).toBe("none");
  });

  it("un-cancels inside the paid period when an ad runs again (no second charge)", () => {
    expect(act(true, sub({ cancelAtPeriodEnd: true }))).toBe("uncancel");
    expect(act(true, sub())).toBe("none");
  });

  it("restarts when an ad runs and the paid period is over or there is no plan", () => {
    expect(act(true, sub({ cancelAtPeriodEnd: true, currentPeriodEnd: earlier }))).toBe("restart");
    expect(act(true, null)).toBe("restart");
  });

  it("leaves exempt accounts, open checkouts and other lines alone", () => {
    expect(act(true, null, true)).toBe("none");
    expect(act(false, sub(), true)).toBe("none");
    expect(act(false, sub({ status: "pending" }))).toBe("none");
    expect(act(false, sub({ line: "managed" }))).toBe("none");
  });

  it("is idempotent: the state after an action asks for nothing more", () => {
    expect(act(false, sub({ cancelAtPeriodEnd: true }))).toBe("none");
    expect(act(true, sub({ cancelAtPeriodEnd: false }))).toBe("none");
  });
});

describe("planGate (launch / resume)", () => {
  const gate = (s: PlanSub, firstMonthUsed = false, exempt = false) =>
    planGate({ exempt, sub: s, firstMonthUsed, buysMedia, now });

  it("lets a new customer launch only through the plan checkout, with the first month included", () => {
    expect(gate(null)).toEqual({ ok: false, error: "plan_required", firstMonthIncluded: true });
  });
  it("offers no free month twice", () => {
    expect(gate(null, true)).toEqual({ ok: false, error: "plan_required", firstMonthIncluded: false });
    expect(gate(sub({ status: "canceled" }), true)).toEqual({ ok: false, error: "plan_required", firstMonthIncluded: false });
  });
  it("passes a paid plan, including a stopping one still inside its period", () => {
    expect(gate(sub())).toEqual({ ok: true });
    expect(gate(sub({ cancelAtPeriodEnd: true }))).toEqual({ ok: true });
    expect(gate(sub({ status: "past_due" }))).toEqual({ ok: true });
  });
  it("refuses a stopping plan whose period ran out", () => {
    expect(gate(sub({ cancelAtPeriodEnd: true, currentPeriodEnd: earlier }), true).ok).toBe(false);
  });
  it("says a just-paid checkout is pending, and a video-only plan has no ads", () => {
    expect(gate(sub({ status: "pending" }))).toEqual({ ok: false, error: "plan_pending" });
    expect(gate(sub({ line: "offer" }))).toEqual({ ok: false, error: "plan_has_no_ads" });
  });
  it("exempts admins (not in test mode) and at_cost", () => {
    expect(gate(null, true, true)).toEqual({ ok: true });
  });
  it("answers a body the web can act on", () => {
    expect(planGateBody({ ok: false, error: "plan_required", firstMonthIncluded: true })).toMatchObject({
      error: "plan_required",
      firstMonthIncluded: true,
    });
    expect(planGateBody({ ok: false, error: "plan_pending" }).error).toBe("plan_pending");
  });
});

describe("planAllowsRunning (automatic restart after a top-up)", () => {
  it("needs a plan that covers now", () => {
    expect(planAllowsRunning({ exempt: false, sub: sub(), now })).toBe(true);
    expect(planAllowsRunning({ exempt: false, sub: sub({ cancelAtPeriodEnd: true, currentPeriodEnd: earlier }), now })).toBe(false);
    expect(planAllowsRunning({ exempt: false, sub: null, now })).toBe(false);
    expect(planAllowsRunning({ exempt: true, sub: null, now })).toBe(true);
  });
});

describe("$55 a month: plan terms", () => {
  const base = {
    line: "evergreen",
    listFeeMinor: 2_000,
    rechargeMinor: 3_500,
    billingMode: "platform" as string | null,
    testMode: false,
  };

  it("every plan is $20 plus a $35 monthly ad budget", () => {
    expect(planTerms(base)).toEqual({ feeMinor: 2_000, budgetRechargeMinor: 3_500 });
    // No ad account yet (the default is platform-billed): same.
    expect(planTerms({ ...base, billingMode: null })).toEqual({ feeMinor: 2_000, budgetRechargeMinor: 3_500 });
  });

  it("no recharge when Google bills the customer's own card", () => {
    expect(planTerms({ ...base, billingMode: "customer" })).toEqual({ feeMinor: 2_000, budgetRechargeMinor: 0 });
  });

  it("test mode charges both lines at the 50-cent test price", () => {
    expect(planTerms({ ...base, testMode: true })).toEqual({ feeMinor: 50, budgetRechargeMinor: 50 });
  });

  it("other lines get their list fee and no recharge", () => {
    expect(planTerms({ ...base, line: "offer", listFeeMinor: 3_900 })).toEqual({ feeMinor: 3_900, budgetRechargeMinor: 0 });
  });
});

describe("$55 a month: what keeps the plan billing", () => {
  it("a running ad, or an ad waiting for budget on a recharging plan; never a customer pause", () => {
    expect(adWantsPlan({ running: true, waitingForBudget: false, planRecharges: false })).toBe(true);
    expect(adWantsPlan({ running: false, waitingForBudget: true, planRecharges: true })).toBe(true);
    // Grandfathered (no recharge): an empty budget stops the plan as before.
    expect(adWantsPlan({ running: false, waitingForBudget: true, planRecharges: false })).toBe(false);
    expect(adWantsPlan({ running: false, waitingForBudget: false, planRecharges: true })).toBe(false);
  });
});

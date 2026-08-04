import { describe, expect, it } from "vitest";
import {
  addMonth,
  dunningDecision,
  entitlesToService,
  feeFunding,
  feeLedgerRefs,
  firstPeriod,
  GRACE_DAYS,
  isDue,
  MAX_CHARGE_ATTEMPTS,
  monthStart,
  nextPeriod,
} from "./policy.js";

const utc = (s: string) => new Date(s);

describe("addMonth", () => {
  it("advances a normal date", () => {
    expect(addMonth(utc("2026-03-10T00:00:00Z")).toISOString()).toBe("2026-04-10T00:00:00.000Z");
  });

  it("clamps 31 January to the end of February instead of overflowing into March", () => {
    // The bug this exists to prevent: setMonth(m + 1) on 31 Jan lands on 3 March
    // in a non-leap year, giving away two days and then billing on the 3rd
    // forever after.
    expect(addMonth(utc("2026-01-31T00:00:00Z")).toISOString()).toBe("2026-02-28T00:00:00.000Z");
  });

  it("clamps to 29 February in a leap year", () => {
    expect(addMonth(utc("2028-01-31T00:00:00Z")).toISOString()).toBe("2028-02-29T00:00:00.000Z");
  });

  it("rolls the year over in December", () => {
    expect(addMonth(utc("2026-12-15T00:00:00Z")).toISOString()).toBe("2027-01-15T00:00:00.000Z");
  });

  it("preserves the time of day, so renewals do not drift earlier each month", () => {
    expect(addMonth(utc("2026-03-10T09:30:00Z")).toISOString()).toBe("2026-04-10T09:30:00.000Z");
  });
});

describe("period chaining", () => {
  it("anchors the next period to the previous END, not to now", () => {
    // Anchoring to "now" would let every retry or late webhook push the renewal
    // date forward, migrating a subscriber billed on the 3rd to the 20th.
    const first = firstPeriod(utc("2026-01-05T00:00:00Z"));
    const second = nextPeriod(first);
    expect(second.start.toISOString()).toBe(first.end.toISOString());
    expect(second.end.toISOString()).toBe("2026-03-05T00:00:00.000Z");
  });

  it("keeps a month-end subscriber anchored to month ends across a short month", () => {
    let period = firstPeriod(utc("2026-01-31T00:00:00Z"));
    expect(period.end.toISOString()).toBe("2026-02-28T00:00:00.000Z");
    period = nextPeriod(period);
    // Once clamped the anchor becomes the 28th. It does not spring back to the
    // 31st, which is the standard, and less surprising, subscription behaviour.
    expect(period.end.toISOString()).toBe("2026-03-28T00:00:00.000Z");
  });

  it("is due only once the period end has passed", () => {
    const period = firstPeriod(utc("2026-01-05T00:00:00Z"));
    expect(isDue(period, utc("2026-02-04T23:59:59Z"))).toBe(false);
    expect(isDue(period, utc("2026-02-05T00:00:00Z"))).toBe(true);
  });
});

describe("monthStart", () => {
  it("normalises any instant to the first of its month, UTC", () => {
    expect(monthStart(utc("2026-08-19T17:45:12Z")).toISOString()).toBe("2026-08-01T00:00:00.000Z");
  });
});

describe("dunning", () => {
  const firstFailureAt = utc("2026-05-01T00:00:00Z");

  it("keeps serving on the first failure", () => {
    const d = dunningDecision({
      failedChargeCount: 1,
      firstFailureAt,
      now: utc("2026-05-01T00:00:00Z"),
    });
    expect(d.action).toBe("retry");
    expect(d.keepServing).toBe(true);
  });

  it("widens the gap between retries", () => {
    const at = (n: number) =>
      dunningDecision({ failedChargeCount: n, firstFailureAt, now: utc("2026-05-01T00:00:00Z") });
    const first = at(1);
    const second = at(2);
    if (first.action !== "retry" || second.action !== "retry") throw new Error("expected retries");
    expect(second.nextAttemptAt.getTime()).toBeGreaterThan(first.nextAttemptAt.getTime());
  });

  it("expires once the attempts run out", () => {
    const d = dunningDecision({
      failedChargeCount: MAX_CHARGE_ATTEMPTS,
      firstFailureAt,
      now: utc("2026-05-02T00:00:00Z"),
    });
    expect(d.action).toBe("expire");
    expect(d.keepServing).toBe(false);
  });

  it("expires once the grace window closes, even with attempts left", () => {
    // Otherwise a subscriber whose provider stops retrying stays in past_due
    // forever, which is a free customer we keep producing videos for.
    const d = dunningDecision({
      failedChargeCount: 1,
      firstFailureAt,
      now: new Date(firstFailureAt.getTime() + (GRACE_DAYS + 1) * 86_400_000),
    });
    expect(d.action).toBe("expire");
  });
});

describe("entitlesToService", () => {
  it("serves active and past_due, and nothing else", () => {
    // past_due deliberately serves — that is what the grace window IS.
    expect(entitlesToService("active")).toBe(true);
    expect(entitlesToService("past_due")).toBe(true);
    expect(entitlesToService("pending")).toBe(false);
    expect(entitlesToService("canceled")).toBe(false);
    expect(entitlesToService("expired")).toBe(false);
  });
});

describe("feeFunding", () => {
  it("draws a platform-billed managed fee from the prepaid wallet", () => {
    expect(feeFunding("managed", "platform")).toBe("wallet");
  });

  it("treats a customer-billed managed fee as externally funded", () => {
    // Their card pays Google directly; the fee money never sits in our wallet,
    // so posting a bare debit would fail with insufficient_funds for someone
    // whose payment just succeeded.
    expect(feeFunding("managed", "customer")).toBe("external");
  });

  it("treats the offer line as externally funded, with or without an ad account", () => {
    expect(feeFunding("offer", null)).toBe("external");
    expect(feeFunding("offer", "platform")).toBe("external");
  });

  it("does not default a missing billing mode to the wallet", () => {
    // A managed subscriber with no active ad account has no prepaid balance to
    // draw on. Defaulting to 'wallet' here would block their very first charge.
    expect(feeFunding("managed", null)).toBe("external");
  });
});

describe("feeLedgerRefs", () => {
  it("gives the credit and the debit distinct idempotency keys", () => {
    // They share a wallet, and the partial unique index is on
    // (wallet_id, external_ref) — identical refs would make the second insert
    // collide and the fee silently never land.
    const refs = feeLedgerRefs("2b0f0e5e-0000-4000-8000-000000000000");
    expect(refs.credit).not.toBe(refs.fee);
    expect(refs.fee.startsWith(refs.credit)).toBe(true);
  });

  it("derives from our invoice id, not the provider's", () => {
    // The same invoice can be retried across providers and must still post once.
    expect(feeLedgerRefs("abc").credit).toBe("subinv:abc");
  });
});

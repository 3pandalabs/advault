import { createHmac } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { routeStripeEvent } from "../../payments/stripeRouting.js";

vi.hoisted(() => {
  process.env.STRIPE_SECRET_KEY ??= "rk_test_x";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_unit";
});

let stripe: typeof import("./stripe.js");
beforeAll(async () => {
  stripe = await import("./stripe.js");
});

function verify(event: Record<string, unknown>) {
  const body = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", "whsec_unit").update(`${t}.${body}`).digest("hex");
  return stripe.stripeSubscriptions.verifyWebhook(body, { "stripe-signature": `t=${t},v1=${v1}` });
}

const meta = { subscription_id: "s1", invoice_id: "i1", app: "advault" };

describe("Stripe plan webhook", () => {
  it("marks both copies of the first payment as first, with the sub_ / cus_ ids", () => {
    const a = verify({
      type: "checkout.session.completed",
      data: { object: { id: "cs_1", mode: "subscription", amount_total: 0, currency: "usd", subscription: "sub_1", customer: "cus_1", metadata: meta } },
    });
    expect(a).toMatchObject({ kind: "paid", amountMinor: 0, firstPayment: true, providerSubscriptionRef: "sub_1", providerCustomerRef: "cus_1" });
    const b = verify({
      type: "invoice.paid",
      data: { object: { id: "in_1", billing_reason: "subscription_create", amount_paid: 0, currency: "usd", subscription: "sub_1", subscription_details: { metadata: meta } } },
    });
    expect(b).toMatchObject({ kind: "paid", invoiceId: "i1", firstPayment: true });
  });

  it("treats a renewal as not first, and reads parent.subscription_details on newer API versions", () => {
    const e = verify({
      type: "invoice.paid",
      data: {
        object: {
          id: "in_2",
          billing_reason: "subscription_cycle",
          amount_paid: 1900,
          currency: "usd",
          parent: { subscription_details: { metadata: meta, subscription: "sub_1" } },
        },
      },
    });
    expect(e).toMatchObject({ kind: "paid", invoiceId: "i1", firstPayment: false, providerSubscriptionRef: "sub_1" });
    expect(
      routeStripeEvent({ type: "invoice.paid", data: { object: { parent: { subscription_details: { metadata: meta } } } } } as never),
    ).toBe("subscriptions");
  });
});

describe("Stripe plan helpers", () => {
  it("trial_end is the included month's end, in seconds", () => {
    expect(stripe.stripeTrialFields(new Date("2026-12-19T00:00:00Z"))).toEqual({
      "subscription_data[trial_end]": String(Date.UTC(2026, 11, 19) / 1000),
    });
    expect(stripe.stripeTrialFields(null)).toEqual({});
  });

  it("a restart charges now with the saved card, tagged like a checkout", () => {
    const base = {
      customerRef: "cus_1",
      paymentMethod: "pm_1",
      priceId: "price_19",
      productId: "prod_1",
      amountMinor: 1900,
      currency: "USD",
      subscriptionId: "s2",
      invoiceId: "i2",
    };
    const real = stripe.stripeRestartForm({ ...base, testMode: false, internal: true, internalLabel: "SiteVault" });
    expect(real).toMatchObject({
      customer: "cus_1",
      default_payment_method: "pm_1",
      payment_behavior: "error_if_incomplete",
      "items[0][price]": "price_19",
      "metadata[invoice_id]": "i2",
      "metadata[app]": "advault",
      "metadata[internal]": "1",
    });
    const test = stripe.stripeRestartForm({ ...base, amountMinor: 50, testMode: true });
    expect(test).toMatchObject({
      "items[0][price_data][unit_amount]": "50",
      "items[0][price_data][product]": "prod_1",
      "metadata[test_mode]": "1",
    });
    expect(test["items[0][price]"]).toBeUndefined();
  });
});

describe("$55 a month: Stripe lines", () => {
  const req = {
    subscriptionId: "s1",
    invoiceId: "i1",
    planKey: "us-evergreen",
    amountMinor: 2000,
    currency: "USD" as const,
    userEmail: "a@x.test",
    returnUrl: "https://x.test",
  };

  it("uses STRIPE_PRICE_US_EVERGREEN for the $20 plan, inline for any other amount", () => {
    process.env.STRIPE_PRICE_US_EVERGREEN = "price_20";
    expect(stripe.stripePlanPriceId("us-evergreen", 2000)).toBe("price_20");
    expect(stripe.stripePlanPriceId("us-evergreen", 50)).toBeNull();
    expect(stripe.stripePlanPriceId("us-evergreen", 1900)).toBeNull();
    delete process.env.STRIPE_PRICE_US_EVERGREEN;
    expect(stripe.stripePlanPriceId("us-evergreen", 2000)).toBeNull();
  });

  it("a new plan is two recurring lines: the $20 plan and the $35 ad budget", () => {
    process.env.STRIPE_PRICE_US_EVERGREEN = "price_20";
    process.env.STRIPE_PRICE_US_AD_BUDGET = "price_budget";
    expect(stripe.stripeSubscriptionLine({ ...req, budgetMinor: 3500 })).toEqual({
      "line_items[0][price]": "price_20",
      "line_items[0][quantity]": "1",
      "line_items[1][price]": "price_budget",
      "line_items[1][quantity]": "1",
    });
    // A customer-billed ad account: one line, the plan.
    expect(stripe.stripeSubscriptionLine({ ...req, budgetMinor: 0 })).toEqual({
      "line_items[0][price]": "price_20",
      "line_items[0][quantity]": "1",
    });
  });

  it("without the new price objects it charges the right amounts inline", () => {
    delete process.env.STRIPE_PRICE_US_EVERGREEN;
    delete process.env.STRIPE_PRICE_US_AD_BUDGET;
    expect(stripe.stripeSubscriptionLine({ ...req, budgetMinor: 3500 })).toMatchObject({
      "line_items[0][price_data][unit_amount]": "2000",
      "line_items[0][price_data][recurring][interval]": "month",
      "line_items[1][price_data][unit_amount]": "3500",
      "line_items[1][price_data][recurring][interval]": "month",
    });
    // Test mode: both at the test price, never a real price object.
    expect(stripe.stripeSubscriptionLine({ ...req, amountMinor: 50, budgetMinor: 50, testMode: true })).toMatchObject({
      "line_items[0][price_data][unit_amount]": "50",
      "line_items[1][price_data][unit_amount]": "50",
    });
  });

  it("a restart carries the budget line too, and one with no recharge does not", () => {
    const common = {
      customerRef: "cus_1",
      paymentMethod: "pm_1",
      productId: "prod_plan",
      testMode: false,
      currency: "USD",
      subscriptionId: "s2",
      invoiceId: "i2",
    };
    expect(
      stripe.stripeRestartForm({ ...common, priceId: "price_20", amountMinor: 2000, budgetMinor: 3500, budgetPriceId: null, budgetProductId: "prod_budget" }),
    ).toMatchObject({
      "items[0][price]": "price_20",
      "items[1][price_data][unit_amount]": "3500",
      "items[1][price_data][product]": "prod_budget",
    });
    const none = stripe.stripeRestartForm({ ...common, priceId: "price_20", amountMinor: 2000 });
    expect(Object.keys(none).some((k) => k.startsWith("items[1]"))).toBe(false);
  });
});

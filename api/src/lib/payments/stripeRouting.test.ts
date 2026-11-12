import { describe, expect, it } from "vitest";
import { routeStripeEvent } from "./stripeRouting.js";

const ev = (type: string, object: Record<string, unknown>) => ({ type, data: { object } });

describe("routeStripeEvent", () => {
  it("sends a $19 ad / cinematic checkout to purchases", () => {
    expect(
      routeStripeEvent(ev("checkout.session.completed", { mode: "payment", metadata: { payment_id: "p", purpose: "add_on", app: "advault" } })),
    ).toBe("purchases");
  });

  it("sends a top-up checkout to payments", () => {
    expect(routeStripeEvent(ev("checkout.session.completed", { mode: "payment", metadata: { payment_id: "p", purpose: "topup" } }))).toBe("payments");
  });

  it("sends subscription checkouts and renewals to subscriptions", () => {
    expect(routeStripeEvent(ev("checkout.session.completed", { mode: "subscription", metadata: { invoice_id: "i" } }))).toBe("subscriptions");
    expect(
      routeStripeEvent(ev("invoice.paid", { metadata: {}, subscription_details: { metadata: { invoice_id: "i", subscription_id: "s" } } })),
    ).toBe("subscriptions");
    expect(routeStripeEvent(ev("customer.subscription.deleted", { metadata: { subscription_id: "s" } }))).toBe("subscriptions");
  });

  it("ignores events from other 3PandaLabs apps on the shared account", () => {
    expect(routeStripeEvent(ev("checkout.session.completed", { metadata: { payment_id: "p", app: "rentvault" } }))).toBe("ignore");
    expect(routeStripeEvent(ev("invoice.paid", { subscription_details: { metadata: { invoice_id: "i", app: "rentvault" } } }))).toBe("ignore");
  });

  it("ignores events no handler wants", () => {
    expect(routeStripeEvent(ev("checkout.session.completed", { mode: "payment", metadata: {} }))).toBe("ignore");
    expect(routeStripeEvent(ev("charge.refunded", { metadata: { payment_id: "p" } }))).toBe("ignore");
    expect(routeStripeEvent(ev("invoice.paid", { metadata: {} }))).toBe("ignore");
  });
});

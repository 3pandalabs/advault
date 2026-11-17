import { describe, expect, it, vi } from "vitest";
import { billingExempt, effectiveMarginMode, effectiveRole, inTestMode, mayToggleTestMode } from "./policy.js";
import { chargeMinor, SITE_OFFER_ADDON, TEST_PRICE_MINOR } from "../pricing/index.js";
import { launchPlanBlock } from "../subscriptions/policy.js";
import { siteOfferQuote } from "../siteOffer/policy.js";
import { stripeSubscriptionLine, stripeSubscriptions } from "../subscriptions/providers/stripe.js";
import { STATEMENT_DESCRIPTOR_SUFFIX, stripe } from "../payments/stripe.js";

const admin = { role: "admin", testAsCustomer: false, marginMode: "standard" };
const tester = { role: "admin", testAsCustomer: true, marginMode: "standard" };
const customer = { role: "advertiser", testAsCustomer: false, marginMode: "standard" };

describe("test mode helper", () => {
  it("only an admin with the flag is in test mode", () => {
    expect(inTestMode(tester)).toBe(true);
    expect(inTestMode(admin)).toBe(false);
    // The flag means nothing on a non-admin (e.g. demoted while it was on).
    expect(inTestMode({ ...customer, testAsCustomer: true })).toBe(false);
  });

  it("an admin testing as a customer acts as a standard advertiser", () => {
    expect(effectiveRole(tester)).toBe("advertiser");
    expect(effectiveRole(admin)).toBe("admin");
    expect(effectiveRole(customer)).toBe("advertiser");
    expect(effectiveRole({ role: undefined })).toBeUndefined();
    expect(effectiveMarginMode({ ...tester, marginMode: "at_cost" })).toBe("standard");
  });

  it("exemptions: real admins and at_cost, never a tester", () => {
    expect(billingExempt(admin)).toBe(true);
    expect(billingExempt(tester)).toBe(false);
    expect(billingExempt({ ...tester, marginMode: "at_cost" })).toBe(false);
    expect(billingExempt(customer)).toBe(false);
    // at_cost customers are unchanged.
    expect(billingExempt({ ...customer, marginMode: "at_cost" })).toBe(true);
  });

  it("only an admin may toggle", () => {
    expect(mayToggleTestMode("admin")).toBe(true);
    expect(mayToggleTestMode("advertiser")).toBe(false);
    expect(mayToggleTestMode(undefined)).toBe(false);
  });

  it("launch plan gate applies to a tester (no plan = 402 plan_required)", () => {
    const gate = (s: typeof admin) => launchPlanBlock({ role: effectiveRole(s), marginMode: effectiveMarginMode(s), sub: null });
    expect(gate(admin)).toBeNull();
    expect(gate(tester)).toBe("plan_required");
  });
});

describe("test price", () => {
  it("is 50 cents, Stripe's USD minimum", () => {
    expect(TEST_PRICE_MINOR).toBe(50);
  });

  it("replaces any real charge in test mode, never a $0 waiver", () => {
    expect(chargeMinor(1000, true)).toBe(50);
    expect(chargeMinor(1900, true)).toBe(50);
    expect(chargeMinor(0, true)).toBe(0);
    expect(chargeMinor(1000, false)).toBe(1000);
  });

  it("the offer combo's $2 add-on is the test price too", () => {
    const q = siteOfferQuote({
      isSiteVaultSite: true,
      hasOffer: true,
      status: { billing: "on", credits: 0, siteState: "live" },
      exempt: false,
      currency: "USD",
      ticked: true,
      testMode: true,
    });
    expect(q).toMatchObject({ mode: "paid", addonMinor: 50 });
    expect(SITE_OFFER_ADDON.USD?.priceMinor).toBe(200);
  });

  it("a test subscription uses an inline monthly price, not the fixed price id", () => {
    const line = stripeSubscriptionLine({
      subscriptionId: "s",
      invoiceId: "i",
      planKey: "us-evergreen",
      amountMinor: 50,
      currency: "USD",
      userEmail: "a@b.c",
      returnUrl: "https://x",
      testMode: true,
    });
    expect(line).toEqual({
      "line_items[0][price_data][currency]": "usd",
      "line_items[0][price_data][unit_amount]": "50",
      "line_items[0][price_data][recurring][interval]": "month",
      "line_items[0][price_data][product_data][name]": "AdVault plan (test)",
    });
  });

  it("a test checkout is tagged test_mode=1 in Stripe metadata; a real one is not", async () => {
    const bodies: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: { body: URLSearchParams }) => {
      bodies.push(String(init.body));
      return new Response(JSON.stringify({ id: "cs_1", url: "https://stripe.test" }), { status: 200 });
    });
    const req = { paymentId: "p", amountMinor: 50, currency: "USD" as const, purpose: "add_on" as const, userEmail: "a@b.c", returnUrl: "https://x" };
    await stripe.createCheckout({ ...req, testMode: true });
    await stripe.createCheckout(req);
    vi.unstubAllGlobals();
    expect(new URLSearchParams(bodies[0]).get("metadata[test_mode]")).toBe("1");
    expect(new URLSearchParams(bodies[0]).get("line_items[0][price_data][unit_amount]")).toBe("50");
    expect(new URLSearchParams(bodies[1]).get("metadata[test_mode]")).toBeNull();
  });

  it("one-off checkouts carry the ADVAULT statement descriptor suffix; subscriptions don't (Stripe 400s)", async () => {
    const bodies: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: { body: URLSearchParams }) => {
      bodies.push(String(init.body));
      return new Response(JSON.stringify({ id: "cs_1", url: "https://stripe.test" }), { status: 200 });
    });
    await stripe.createCheckout({ paymentId: "p", amountMinor: 50, currency: "USD", purpose: "add_on", userEmail: "a@b.c", returnUrl: "https://x" });
    await stripeSubscriptions.createCheckout({
      subscriptionId: "s",
      invoiceId: "i",
      planKey: "us-evergreen",
      amountMinor: 50,
      currency: "USD",
      userEmail: "a@b.c",
      returnUrl: "https://x",
      testMode: true,
    });
    vi.unstubAllGlobals();
    const payment = new URLSearchParams(bodies[0]);
    expect(payment.get("mode")).toBe("payment");
    expect(payment.get("payment_intent_data[statement_descriptor_suffix]")).toBe("ADVAULT");
    expect(STATEMENT_DESCRIPTOR_SUFFIX).toMatch(/^[A-Z0-9 ]{1,10}$/);
    const sub = new URLSearchParams(bodies[1]);
    expect(sub.get("mode")).toBe("subscription");
    expect([...sub.keys()].some((k) => k.startsWith("payment_intent_data"))).toBe(false);
  });
});

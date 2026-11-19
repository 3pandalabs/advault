import { describe, expect, it, vi } from "vitest";
import {
  accountLabel,
  billingExempt,
  effectiveMarginMode,
  effectiveRole,
  internalLabel,
  inTestMode,
  isUndeliverableEmail,
  mayToggleTestMode,
  maySwitchInto,
  testLabel,
} from "./policy.js";
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
      "line_items[0][quantity]": "1",
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

describe("admin test customers (0030)", () => {
  const testCustomer = { role: "advertiser", testOwnerId: "admin-1", marginMode: "standard" };

  it("is always in test mode, billed as a standard advertiser, never exempt", () => {
    expect(inTestMode(testCustomer)).toBe(true);
    expect(effectiveRole(testCustomer)).toBe("advertiser");
    expect(billingExempt(testCustomer)).toBe(false);
    expect(billingExempt({ ...testCustomer, marginMode: "at_cost" })).toBe(false);
    expect(inTestMode({ ...testCustomer, testOwnerId: null })).toBe(false);
  });

  it("names say TEST, once", () => {
    expect(testLabel("Lawn Pros", true)).toBe("TEST · Lawn Pros");
    expect(testLabel("TEST · Lawn Pros", true)).toBe("TEST · Lawn Pros");
    expect(testLabel("Lawn Pros", false)).toBe("Lawn Pros");
  });

  it("*.invalid addresses are undeliverable", () => {
    expect(isUndeliverableEmail("test-ab12@test.advault.invalid")).toBe(true);
    expect(isUndeliverableEmail("owner@example.com")).toBe(false);
    expect(isUndeliverableEmail(undefined)).toBe(false);
  });

  it("only the owning admin may switch in", () => {
    expect(maySwitchInto({ actorOwnerId: "a", target: { testOwnerId: "a" } })).toBe(true);
    expect(maySwitchInto({ actorOwnerId: "b", target: { testOwnerId: "a" } })).toBe(false);
    expect(maySwitchInto({ actorOwnerId: "a", target: { testOwnerId: null } })).toBe(false);
    expect(maySwitchInto({ actorOwnerId: "a", target: { testOwnerId: "a", deletedAt: new Date() } })).toBe(false);
    expect(maySwitchInto({ actorOwnerId: "a", target: null })).toBe(false);
  });
});

describe("internal accounts (0032)", () => {
  it("names say INTERNAL, once; TEST still applies on top", () => {
    expect(internalLabel("SiteVault", true)).toBe("INTERNAL · SiteVault");
    expect(internalLabel("INTERNAL · SiteVault", true)).toBe("INTERNAL · SiteVault");
    expect(internalLabel("SiteVault", false)).toBe("SiteVault");
    expect(accountLabel("Lawn Pros", { testCustomer: false, internal: false })).toBe("Lawn Pros");
    expect(accountLabel("SiteVault", { testCustomer: false, internal: true })).toBe("INTERNAL · SiteVault");
    expect(accountLabel("Lawn Pros", { testCustomer: true, internal: false })).toBe("TEST · Lawn Pros");
  });

  it("one-off and subscription checkouts carry internal=1 + label at full price; others don't", async () => {
    const bodies: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: { body: URLSearchParams }) => {
      bodies.push(String(init.body));
      return new Response(JSON.stringify({ id: "cs_1", url: "https://stripe.test" }), { status: 200 });
    });
    const req = { paymentId: "p", amountMinor: 1000, currency: "USD" as const, purpose: "add_on" as const, userEmail: "a@b.c", returnUrl: "https://x" };
    await stripe.createCheckout({ ...req, internal: true, internalLabel: "SiteVault" });
    await stripe.createCheckout(req);
    await stripeSubscriptions.createCheckout({
      subscriptionId: "s",
      invoiceId: "i",
      planKey: "us-evergreen",
      amountMinor: 50,
      currency: "USD",
      userEmail: "a@b.c",
      returnUrl: "https://x",
      // Test-priced line so no price id is needed; the tags are what matter here.
      testMode: true,
      internal: true,
      internalLabel: "RsvpVault",
    });
    vi.unstubAllGlobals();
    const tagged = new URLSearchParams(bodies[0]);
    expect(tagged.get("metadata[internal]")).toBe("1");
    expect(tagged.get("metadata[internal_label]")).toBe("SiteVault");
    expect(tagged.get("payment_intent_data[metadata][internal]")).toBe("1");
    expect(tagged.get("metadata[test_mode]")).toBeNull();
    expect(tagged.get("line_items[0][price_data][unit_amount]")).toBe("1000");
    const plain = new URLSearchParams(bodies[1]);
    expect([...plain.keys()].some((k) => k.includes("internal"))).toBe(false);
    const sub = new URLSearchParams(bodies[2]);
    expect(sub.get("metadata[internal]")).toBe("1");
    expect(sub.get("subscription_data[metadata][internal]")).toBe("1");
    expect(sub.get("subscription_data[metadata][internal_label]")).toBe("RsvpVault");
  });
});

import { describe, expect, it } from "vitest";
import {
  SITE_OFFER_MAX_ATTEMPTS,
  shouldPushSiteOffer,
  siteOfferOutcome,
  siteOfferQuote,
  sitevaultPayment,
  type SiteOfferQuoteInput,
} from "./policy.js";
import { SITE_OFFER_ADDON } from "../pricing/index.js";
import { stripeLineItems } from "../payments/stripe.js";

const base: SiteOfferQuoteInput = {
  isSiteVaultSite: true,
  hasOffer: true,
  status: { billing: "on", credits: 0, siteState: "live" },
  exempt: false,
  currency: "USD",
  ticked: true,
};

describe("siteOfferQuote", () => {
  it("$2 add-on when billing is on and the site has no credits", () => {
    expect(siteOfferQuote(base)).toEqual({ available: true, offered: "paid", mode: "paid", addonMinor: 200 });
  });

  it("uses a SiteVault credit when there is one: the customer pays $10", () => {
    expect(siteOfferQuote({ ...base, status: { billing: "on", credits: 2, siteState: "live" } })).toEqual({
      available: true,
      offered: "credit",
      mode: "credit",
      addonMinor: 0,
    });
  });

  it("free when SiteVault billing is off, and for admins / at_cost", () => {
    expect(siteOfferQuote({ ...base, status: { billing: "off", credits: 0, siteState: "live" } }).mode).toBe("free");
    expect(siteOfferQuote({ ...base, exempt: true })).toEqual({ available: true, offered: "free", mode: "free", addonMinor: 0 });
  });

  it("unticked: offered for the label, but nothing recorded or charged", () => {
    expect(siteOfferQuote({ ...base, ticked: false })).toEqual({ available: true, offered: "paid", mode: null, addonMinor: 0 });
  });

  it("hidden when not a SiteVault site, no offer text, SiteVault unreachable, or the site isn't showing", () => {
    const none = { available: false, offered: null, mode: null, addonMinor: 0 };
    expect(siteOfferQuote({ ...base, isSiteVaultSite: false })).toEqual(none);
    expect(siteOfferQuote({ ...base, hasOffer: false })).toEqual(none);
    expect(siteOfferQuote({ ...base, status: null })).toEqual(none);
    expect(siteOfferQuote({ ...base, status: { billing: "on", credits: 3, siteState: "paused" } })).toEqual(none);
    expect(siteOfferQuote({ ...base, status: { billing: "off", credits: 3, siteState: "unpublished" } })).toEqual(none);
    expect(siteOfferQuote({ ...base, status: { billing: "on", credits: 0, siteState: "grace" } }).available).toBe(true);
  });

  it("the paid add-on is US only, like new_ad", () => {
    expect(SITE_OFFER_ADDON.INR).toBeUndefined();
    expect(siteOfferQuote({ ...base, currency: "INR" }).available).toBe(false);
    // ...but a credit or billing-off site needs no INR price.
    expect(siteOfferQuote({ ...base, currency: "INR", status: { billing: "on", credits: 1, siteState: "live" } }).mode).toBe("credit");
  });
});

describe("sitevaultPayment", () => {
  it("only credit mode spends a SiteVault credit", () => {
    expect(sitevaultPayment("credit")).toBe("credit");
    expect(sitevaultPayment("paid")).toBe("advault");
    expect(sitevaultPayment("free")).toBe("advault");
  });
});

const row = { siteOfferMode: "paid", siteOfferPushedAt: null, siteOfferError: null, siteOfferAttempts: 0, status: "paid" };

describe("shouldPushSiteOffer", () => {
  it("pushes a paid, un-pushed site offer with attempts left", () => {
    expect(shouldPushSiteOffer(row)).toBe(true);
    expect(shouldPushSiteOffer({ ...row, status: "delivered" })).toBe(true);
  });
  it("never before payment, twice, without a mode, or past the cap", () => {
    expect(shouldPushSiteOffer({ ...row, status: "pending" })).toBe(false);
    expect(shouldPushSiteOffer({ ...row, status: "cancelled" })).toBe(false);
    expect(shouldPushSiteOffer({ ...row, siteOfferPushedAt: new Date() })).toBe(false);
    expect(shouldPushSiteOffer({ ...row, siteOfferMode: null })).toBe(false);
    expect(shouldPushSiteOffer({ ...row, siteOfferAttempts: SITE_OFFER_MAX_ATTEMPTS })).toBe(false);
  });
});

describe("siteOfferOutcome", () => {
  it("updated / pending / retrying / failed", () => {
    expect(siteOfferOutcome({ ...row, siteOfferPushedAt: new Date() })).toBe("updated");
    expect(siteOfferOutcome(row)).toBe("pending");
    expect(siteOfferOutcome({ ...row, siteOfferError: "sitevault_502", siteOfferAttempts: 1 })).toBe("retrying");
    expect(siteOfferOutcome({ ...row, siteOfferError: "sitevault_502", siteOfferAttempts: SITE_OFFER_MAX_ATTEMPTS })).toBe("failed");
  });
  it("nothing to say before payment or without a website offer", () => {
    expect(siteOfferOutcome({ ...row, status: "pending" })).toBeNull();
    expect(siteOfferOutcome({ ...row, siteOfferMode: null })).toBeNull();
  });
});

describe("stripeLineItems", () => {
  const req = { paymentId: "p", currency: "USD" as const, purpose: "add_on" as const, userEmail: "", returnUrl: "" };
  it("one line by default", () => {
    expect(stripeLineItems({ ...req, amountMinor: 1000 })).toEqual({
      "line_items[0][quantity]": "1",
      "line_items[0][price_data][currency]": "usd",
      "line_items[0][price_data][unit_amount]": "1000",
      "line_items[0][price_data][product_data][name]": "AdVault campaign fee",
    });
  });
  it("the new ad plus the $2 website line", () => {
    const f = stripeLineItems({
      ...req,
      amountMinor: 1200,
      lineItems: [
        { amountMinor: 1000, name: "AdVault new ad" },
        { amountMinor: 200, name: "Offer on your website" },
      ],
    });
    expect(f["line_items[1][price_data][unit_amount]"]).toBe("200");
    expect(f["line_items[1][price_data][product_data][name]"]).toBe("Offer on your website");
    expect(f["line_items[0][price_data][unit_amount]"]).toBe("1000");
  });
  it("ignores a breakdown that doesn't sum to the amount", () => {
    const f = stripeLineItems({ ...req, amountMinor: 1200, lineItems: [{ amountMinor: 1000, name: "x" }] });
    expect(f["line_items[0][price_data][unit_amount]"]).toBe("1200");
    expect(f["line_items[1][quantity]"]).toBeUndefined();
  });
});

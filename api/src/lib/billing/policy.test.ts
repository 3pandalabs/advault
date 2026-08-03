import { describe, expect, it } from "vitest";
import {
  billingGate,
  canSwitchMode,
  invoiceShapeFor,
  needsBillingLinkPolling,
  offeredModeList,
  offeredModes,
  requiresWalletCheck,
  resolveRequestedMode,
  shouldPromptForMode,
  type BillingAccountView,
} from "./policy.js";

// The first tests in this repo. They cover the billing-mode policy because it
// is the part of the money path that is pure — every other guard needs a live
// Postgres or a Google developer token, neither of which exists in CI.
//
// What is deliberately NOT tested here: anything in ./link.ts or
// ../googleAds/billingLink.ts. Those are written against documented v18
// contracts that have never been exercised against a real developer token, and
// a mock of an API nobody has called only asserts that the mock matches the
// guess.

function account(over: Partial<BillingAccountView> = {}): BillingAccountView {
  return {
    isManaged: true,
    status: "active",
    provisionStatus: "active",
    billingMode: "customer",
    billingLinkStatus: "active",
    ...over,
  };
}

describe("offeredModes", () => {
  it("defaults to both when unset", () => {
    expect(offeredModes({ configured: undefined, mccConfigured: true })).toEqual({
      platform: true,
      customer: true,
    });
  });

  it("drops platform when the MCC is not configured", () => {
    // There is no payments account to attach without an MCC, so offering it
    // would walk an advertiser through a choice that fails at the last step.
    expect(offeredModes({ configured: "platform,customer", mccConfigured: false })).toEqual({
      platform: false,
      customer: true,
    });
  });

  it("honours a single configured mode", () => {
    expect(offeredModes({ configured: "customer", mccConfigured: true })).toEqual({
      platform: false,
      customer: true,
    });
  });

  it("falls back to both rather than disabling onboarding on garbage input", () => {
    // A typo in an env var must not take signup offline.
    expect(offeredModes({ configured: "nonsense", mccConfigured: true })).toEqual({
      platform: true,
      customer: true,
    });
  });

  it("tolerates whitespace and casing", () => {
    expect(offeredModes({ configured: " Platform , CUSTOMER ", mccConfigured: true })).toEqual({
      platform: true,
      customer: true,
    });
  });

  it("prompts only when both are on offer", () => {
    expect(shouldPromptForMode({ platform: true, customer: true })).toBe(true);
    expect(shouldPromptForMode({ platform: false, customer: true })).toBe(false);
    expect(offeredModeList({ platform: false, customer: true })).toEqual(["customer"]);
  });
});

describe("resolveRequestedMode", () => {
  const both = { platform: true, customer: true };
  const customerOnly = { platform: false, customer: true };

  it("requires a choice when both are offered", () => {
    expect(resolveRequestedMode(undefined, both)).toEqual({
      ok: false,
      code: "billing_mode_required",
    });
  });

  it("infers the only mode when just one is offered", () => {
    expect(resolveRequestedMode(undefined, customerOnly)).toEqual({ ok: true, mode: "customer" });
  });

  it("refuses a mode that is not offered rather than downgrading", () => {
    // The important one: silently substituting 'platform' would put an
    // advertiser on AdVault's credit card without them asking.
    expect(resolveRequestedMode("platform", customerOnly)).toEqual({
      ok: false,
      code: "billing_mode_unavailable",
    });
  });

  it("refuses an unknown value", () => {
    expect(resolveRequestedMode("free", both)).toEqual({
      ok: false,
      code: "billing_mode_unavailable",
    });
  });

  it("accepts an offered mode", () => {
    expect(resolveRequestedMode("platform", both)).toEqual({ ok: true, mode: "platform" });
  });

  it("reports unavailable when nothing is offered", () => {
    expect(resolveRequestedMode("customer", { platform: false, customer: false })).toEqual({
      ok: false,
      code: "billing_mode_unavailable",
    });
  });
});

describe("billingGate", () => {
  it("blocks a customer-funded managed account with no card yet", () => {
    // THE case this whole gate exists for. Without it the launch succeeds at
    // Google and the campaign silently never serves.
    expect(billingGate(account({ billingLinkStatus: "invited" }))).toEqual({
      ok: false,
      code: "billing_not_configured",
    });
    expect(billingGate(account({ billingLinkStatus: "pending" }))).toEqual({
      ok: false,
      code: "billing_not_configured",
    });
    expect(billingGate(account({ billingLinkStatus: null }))).toEqual({
      ok: false,
      code: "billing_not_configured",
    });
  });

  it("distinguishes a failed handshake from an unfinished one", () => {
    expect(billingGate(account({ billingLinkStatus: "failed" }))).toEqual({
      ok: false,
      code: "billing_link_failed",
    });
  });

  it("allows a customer-funded managed account once billing is live", () => {
    expect(billingGate(account({ billingLinkStatus: "active" }))).toEqual({ ok: true });
  });

  it("never blocks a platform-funded account on the handshake", () => {
    // Platform accounts are backed by the MCC payments account and have no
    // invitation to complete; the schema requires the column stay null.
    expect(billingGate(account({ billingMode: "platform", billingLinkStatus: null }))).toEqual({
      ok: true,
    });
  });

  it("never blocks a brought-your-own account on the handshake", () => {
    // A BYO account already had billing before AdVault existed.
    expect(
      billingGate(
        account({ isManaged: false, billingMode: "customer", billingLinkStatus: null, provisionStatus: null }),
      ),
    ).toEqual({ ok: true });
  });

  it("blocks a revoked account before anything else", () => {
    expect(billingGate(account({ status: "revoked" }))).toEqual({
      ok: false,
      code: "account_revoked",
    });
  });

  it("blocks a managed account still provisioning", () => {
    expect(billingGate(account({ provisionStatus: "pending" }))).toEqual({
      ok: false,
      code: "provisioning_incomplete",
    });
    expect(billingGate(account({ provisionStatus: "failed" }))).toEqual({
      ok: false,
      code: "provisioning_incomplete",
    });
  });
});

describe("requiresWalletCheck", () => {
  it("is keyed on billing mode, not on isManaged", () => {
    // The regression this guards: a managed child the customer pays for looks
    // structurally identical to one we fund. Gating it on the wallet would
    // demand a balance from someone whose card Google already has.
    expect(requiresWalletCheck({ billingMode: "platform" })).toBe(true);
    expect(requiresWalletCheck({ billingMode: "customer" })).toBe(false);
  });
});

describe("needsBillingLinkPolling", () => {
  it("polls only mid-handshake managed customer-funded accounts", () => {
    expect(needsBillingLinkPolling(account({ billingLinkStatus: "invited" }))).toBe(true);
    expect(needsBillingLinkPolling(account({ billingLinkStatus: "pending" }))).toBe(true);
  });

  it("stops once active, and never starts for the other shapes", () => {
    expect(needsBillingLinkPolling(account({ billingLinkStatus: "active" }))).toBe(false);
    expect(needsBillingLinkPolling(account({ billingLinkStatus: "failed" }))).toBe(false);
    expect(
      needsBillingLinkPolling(account({ billingMode: "platform", billingLinkStatus: null })),
    ).toBe(false);
    expect(
      needsBillingLinkPolling(account({ isManaged: false, billingLinkStatus: null })),
    ).toBe(false);
  });
});

describe("invoiceShapeFor", () => {
  it("shows pass-through spend only where there is pass-through spend", () => {
    // Google's Third Party Policy requires a reseller to disclose real ad
    // costs, which only applies where we actually paid them.
    expect(invoiceShapeFor("platform")).toBe("fee_and_pass_through");
    expect(invoiceShapeFor("customer")).toBe("fee_only");
  });
});

describe("canSwitchMode", () => {
  const both = { platform: true, customer: true };

  it("refuses a switch to the mode it is already in", () => {
    expect(canSwitchMode(account({ billingMode: "customer" }), "customer", both)).toEqual({
      ok: false,
      code: "same_mode",
    });
  });

  it("refuses on a brought-your-own account", () => {
    // We do not manage it, so there is nothing to attach our billing to. The
    // schema CHECK enforces the same rule one layer down.
    expect(canSwitchMode(account({ isManaged: false }), "platform", both)).toEqual({
      ok: false,
      code: "unsupported_switch",
    });
  });

  it("refuses a target the deployment does not offer", () => {
    expect(
      canSwitchMode(account({ billingMode: "customer" }), "platform", {
        platform: false,
        customer: true,
      }),
    ).toEqual({ ok: false, code: "billing_mode_unavailable" });
  });

  it("allows customer -> platform without re-opening the handshake", () => {
    expect(canSwitchMode(account({ billingMode: "customer" }), "platform", both)).toEqual({
      ok: true,
      requiresBillingLink: false,
    });
  });

  it("allows platform -> customer but re-opens the handshake", () => {
    // Going back means the advertiser has to accept an invitation and enter a
    // card, so the caller has to know to put them through those steps again.
    expect(
      canSwitchMode(account({ billingMode: "platform", billingLinkStatus: null }), "customer", both),
    ).toEqual({ ok: true, requiresBillingLink: true });
  });
});

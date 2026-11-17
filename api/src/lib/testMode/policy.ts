// Admin "Test as customer": pure decisions. No database (see index.ts beside it).
//
// An admin normally skips every charge and perk gate: no plan needed to
// launch, no $10 per ad, free websites and offer combos, unmetered redos,
// own-video uploads, free video bundle orders. That makes it impossible for
// the owner to walk the paid paths a customer walks. With `test_as_customer`
// on, the admin is billed EXACTLY like a standard advertiser, and every
// Stripe charge is TEST_PRICE_MINOR (lib/pricing) so the real checkout,
// webhook and ledger run end to end for 50 cents.
//
// Every customer-flow check that used to read `role === "admin"` must go
// through here instead. Admin pages and APIs (requireAdmin, /dashboard/admin)
// keep reading the REAL role, so the admin can always switch back.

export type Role = "advertiser" | "admin";

export type BillingSubject = {
  role: string | null | undefined;
  testAsCustomer?: boolean | null;
  marginMode?: string | null;
};

/** An admin testing as a customer: billed as standard, at the test price. */
export function inTestMode(s: BillingSubject): boolean {
  return s.role === "admin" && s.testAsCustomer === true;
}

/**
 * The role customer flows should act on: an admin in test mode is an
 * advertiser. Never use this for admin-only routes.
 */
export function effectiveRole(s: BillingSubject): Role | undefined {
  if (s.role !== "admin" && s.role !== "advertiser") return undefined;
  return inTestMode(s) ? "advertiser" : s.role;
}

/**
 * The margin mode billing should act on. Test mode means "standard
 * advertiser", so it ignores at_cost too; real at_cost accounts are unchanged.
 */
export function effectiveMarginMode(s: BillingSubject): "standard" | "at_cost" {
  if (inTestMode(s)) return "standard";
  return s.marginMode === "at_cost" ? "at_cost" : "standard";
}

/** Skips per-ad fees, website fees and plan gates: real admins and at_cost accounts. */
export function billingExempt(s: BillingSubject): boolean {
  return effectiveRole(s) === "admin" || effectiveMarginMode(s) === "at_cost";
}

/** Only an admin may switch test mode (the flag means nothing on a non-admin). */
export function mayToggleTestMode(role: string | null | undefined): boolean {
  return role === "admin";
}

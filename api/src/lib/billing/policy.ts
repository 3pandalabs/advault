// Pure billing-mode policy. No database, no network — everything here is a
// function of a row and some config, so it can be tested without a live
// Postgres or a Google developer token, which is the only part of this
// subsystem that currently can be.
//
// The three onboarding shapes AdVault offers are not three code paths. They are
// one discriminator (`ad_accounts.billing_mode`) plus which values a deployment
// chooses to offer:
//
//   offer 'platform' only  — every advertiser is funded by our MCC payments
//                            account. One Google hand-off (the OAuth consent),
//                            and we carry the float and the chargeback risk.
//   offer 'customer' only  — every advertiser pays Google themselves. Three
//                            hand-offs, and we carry nothing.
//   offer both             — the advertiser chooses during onboarding.
//
// Deleting the third shape should mean removing one env value and the choice
// step, not unpicking a fork that has grown through the codebase. Keep it that
// way.

export type BillingMode = "platform" | "customer";

export type BillingLinkStatus = "pending" | "invited" | "active" | "failed" | null;

export const BILLING_MODES: readonly BillingMode[] = ["platform", "customer"] as const;

export function isBillingMode(value: unknown): value is BillingMode {
  return value === "platform" || value === "customer";
}

/**
 * The minimal shape the policy functions need. Deliberately not the Drizzle row
 * type — these run against test fixtures far more often than against real rows.
 */
export type BillingAccountView = {
  isManaged: boolean;
  status: string; // 'active' | 'revoked'
  provisionStatus: string | null; // null | 'pending' | 'active' | 'failed'
  billingMode: BillingMode;
  billingLinkStatus: BillingLinkStatus;
};

// ---------------------------------------------------------------------------
// What a deployment offers
// ---------------------------------------------------------------------------

export type OfferedModes = {
  platform: boolean;
  customer: boolean;
};

/**
 * Parses ADVAULT_BILLING_MODES ("platform", "customer", or both comma
 * separated) and intersects it with what is actually wired up.
 *
 * Platform billing needs a configured MCC — without one there is no payments
 * account to attach, so offering it would take an advertiser through a choice
 * that fails at the last step. Customer billing is always offerable: the
 * brought-your-own-account path needs nothing but OAuth.
 */
export function offeredModes(args: {
  configured: string | undefined;
  mccConfigured: boolean;
}): OfferedModes {
  const requested = (args.configured ?? "platform,customer")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(isBillingMode);

  // An unparseable or empty value must not silently disable onboarding.
  const list = requested.length > 0 ? requested : BILLING_MODES;

  return {
    platform: list.includes("platform") && args.mccConfigured,
    customer: list.includes("customer"),
  };
}

export function offeredModeList(offered: OfferedModes): BillingMode[] {
  return BILLING_MODES.filter((m) => offered[m]);
}

/** True when the advertiser should be shown the choice step at all. */
export function shouldPromptForMode(offered: OfferedModes): boolean {
  return offered.platform && offered.customer;
}

export type ModeResolution =
  | { ok: true; mode: BillingMode }
  | { ok: false; code: "billing_mode_unavailable" | "billing_mode_required" };

/**
 * Decides which mode to provision.
 *
 * With one mode offered the request does not get a say — passing the other one
 * is an error rather than a silent downgrade, because a caller that asked for
 * customer-funded and got platform-funded would be handed our credit card
 * without knowing it.
 */
export function resolveRequestedMode(
  requested: string | undefined | null,
  offered: OfferedModes,
): ModeResolution {
  const available = offeredModeList(offered);
  if (available.length === 0) return { ok: false, code: "billing_mode_unavailable" };

  if (requested == null || requested === "") {
    if (available.length === 1) return { ok: true, mode: available[0] };
    return { ok: false, code: "billing_mode_required" };
  }

  if (!isBillingMode(requested) || !offered[requested]) {
    return { ok: false, code: "billing_mode_unavailable" };
  }
  return { ok: true, mode: requested };
}

// ---------------------------------------------------------------------------
// Launch gating
// ---------------------------------------------------------------------------

export type LaunchGate =
  | { ok: true }
  | {
      ok: false;
      code:
        | "account_revoked"
        | "provisioning_incomplete"
        | "billing_not_configured"
        | "billing_link_failed";
    };

/**
 * Whether an account is in a state where a campaign could actually serve.
 *
 * This is deliberately NOT the wallet check — funds are a platform-billing
 * concern and live in lib/wallet. This answers the prior question of whether
 * Google will accept spend on this account at all.
 *
 * The case that matters: a customer-funded managed account whose owner never
 * finished entering a card. Launching into it succeeds at the API level and
 * then silently never delivers, which is the worst possible failure — the
 * advertiser believes they are live and we have no signal that they are not.
 */
export function billingGate(account: BillingAccountView): LaunchGate {
  if (account.status !== "active") return { ok: false, code: "account_revoked" };

  if (account.isManaged && account.provisionStatus !== "active") {
    return { ok: false, code: "provisioning_incomplete" };
  }

  // Only the managed + customer-funded shape has a handshake to be mid-way
  // through. BYO accounts already have billing (they predate us) and
  // platform-funded ones are backed by the MCC.
  if (account.isManaged && account.billingMode === "customer") {
    if (account.billingLinkStatus === "failed") return { ok: false, code: "billing_link_failed" };
    if (account.billingLinkStatus !== "active") {
      return { ok: false, code: "billing_not_configured" };
    }
  }

  return { ok: true };
}

/** Platform-funded accounts spend our money, so they and only they need funds. */
export function requiresWalletCheck(account: Pick<BillingAccountView, "billingMode">): boolean {
  return account.billingMode === "platform";
}

/** Rows the billing-link poller should re-check against Google. */
export function needsBillingLinkPolling(account: BillingAccountView): boolean {
  return (
    account.isManaged &&
    account.billingMode === "customer" &&
    (account.billingLinkStatus === "pending" || account.billingLinkStatus === "invited")
  );
}

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

export type InvoiceShape = "fee_only" | "fee_and_pass_through";

/**
 * Which invoice a mode produces.
 *
 * Platform-funded advertisers are billed for ad spend we fronted, so their
 * invoice must show that spend as a line distinct from our fee. This is not a
 * presentation preference: Google's Third Party Policy requires resellers to
 * disclose actual ad costs, and a single blended figure does not.
 *
 * Customer-funded advertisers pay Google directly and never see a pass-through
 * line from us, because there isn't one.
 */
export function invoiceShapeFor(mode: BillingMode): InvoiceShape {
  return mode === "platform" ? "fee_and_pass_through" : "fee_only";
}

// ---------------------------------------------------------------------------
// Switching between modes
// ---------------------------------------------------------------------------

export type SwitchDecision =
  | { ok: true; requiresBillingLink: boolean }
  | { ok: false; code: "same_mode" | "unsupported_switch" | "billing_mode_unavailable" };

/**
 * Whether an advertiser may move between modes, and what it costs them.
 *
 * customer -> platform on a managed account is clean: we attach our payments
 * account and they stop paying Google directly.
 *
 * platform -> customer is also allowed but re-opens the invitation handshake,
 * so it puts them back through the two Google hand-offs.
 *
 * A brought-your-own account cannot switch at all — we do not manage it, so
 * there is nothing to attach our billing to. The CHECK constraint in the schema
 * enforces the same rule one layer down.
 */
export function canSwitchMode(
  account: BillingAccountView,
  target: BillingMode,
  offered: OfferedModes,
): SwitchDecision {
  if (!offered[target]) return { ok: false, code: "billing_mode_unavailable" };
  if (account.billingMode === target) return { ok: false, code: "same_mode" };
  if (!account.isManaged) return { ok: false, code: "unsupported_switch" };
  return { ok: true, requiresBillingLink: target === "customer" };
}

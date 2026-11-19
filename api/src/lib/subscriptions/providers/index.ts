import type { Currency, ProductLine } from "../../pricing/index.js";
import { paddle } from "./paddle.js";
import { manualSubscriptions } from "./manual.js";
import { razorpaySubscriptions } from "./razorpay.js";
import { stripeSubscriptions } from "./stripe.js";

// Recurring billing, behind one interface.
//
// Separate from lib/payments because a subscription is a different object from
// a one-off charge: it has a mandate, a lifecycle and its own webhook events.
// Sharing the interface would have meant a `PaymentProvider` whose methods only
// apply half the time.

export type SubscriptionProviderName = "razorpay" | "stripe" | "paddle" | "manual";

export type SubscriptionCheckoutRequest = {
  /** Our ids, carried in provider metadata and returned on every webhook. */
  subscriptionId: string;
  invoiceId: string;
  planKey: string;
  amountMinor: number;
  currency: Currency;
  userEmail: string;
  returnUrl: string;
  /**
   * Admin testing as a customer (lib/testMode): charge amountMinor (the $0.50
   * test price) monthly instead of the plan's fixed price id, tagged
   * `test_mode=1`.
   */
  testMode?: boolean;
  /** 3PandaLabs' own account (0032): full price, Stripe tags it `internal=1`. */
  internal?: boolean;
  internalLabel?: string | null;
  /**
   * The included first month (0038, lib/planBilling): nothing is charged
   * until this instant (Stripe `subscription_data[trial_end]`); the card is
   * saved for when the plan starts charging.
   */
  trialEnd?: Date | null;
};

export type SubscriptionCheckout = {
  /** Where to send the browser, or null for providers rendered client-side. */
  redirectUrl: string | null;
  clientPayload: Record<string, unknown>;
  providerRef: string;
};

/**
 * A verified provider event, already reduced to the only four things the
 * lifecycle cares about. Anything else a provider sends is `ignored` — silently
 * dropping unknown event types is correct here, because providers add new ones
 * without warning and a 500 makes them retry forever.
 */
export type SubscriptionEvent =
  | {
      kind: "paid";
      invoiceId: string;
      externalRef: string;
      amountMinor: number;
      currency: Currency;
      raw: unknown;
      /**
       * The provider's first payment for this subscription. Stripe reports it
       * TWICE (checkout.session.completed and invoice.paid with
       * billing_reason subscription_create); whichever lands second is a
       * duplicate, not month two.
       */
      firstPayment?: boolean;
      /** Provider subscription / customer ids (Stripe sub_ / cus_), when present. */
      providerSubscriptionRef?: string | null;
      providerCustomerRef?: string | null;
    }
  | { kind: "failed"; invoiceId: string; reason: string; raw: unknown }
  | { kind: "canceled"; subscriptionId: string; raw: unknown }
  | { kind: "ignored" };

export interface SubscriptionProvider {
  readonly name: SubscriptionProviderName;
  isConfigured(): boolean;
  createCheckout(req: SubscriptionCheckoutRequest): Promise<SubscriptionCheckout>;
  /**
   * Verifies the signature, THEN parses.
   *
   * Returns null for anything that fails verification. Identical trust boundary
   * to lib/payments: a webhook body is attacker-supplied until its signature is
   * checked, and an unverified "paid" event is a free subscription.
   */
  verifyWebhook(
    rawBody: string,
    headers: Record<string, string | undefined>,
  ): SubscriptionEvent | null;
}

const ALL = [razorpaySubscriptions, stripeSubscriptions, paddle, manualSubscriptions];

/**
 * Which rail collects a given sale.
 *
 * The offer line prefers Paddle, and that preference is a tax decision rather
 * than a commercial one. Paddle is the merchant of record: it is the seller,
 * so it carries India's OIDAR GST registration and monthly GSTR-5A filing
 * instead of us. Selling the offer subscription direct would oblige AdVault to
 * register for Indian GST from the FIRST rupee — there is no turnover threshold
 * for a foreign supplier — which is a real recurring cost to take on before
 * anyone has proven they will pay at all.
 *
 * The managed line goes to the currency-native rail, because those customers
 * are already inside the Google Ads relationship and the MoR adds a margin
 * point for nothing.
 *
 * Everything falls back to `manual` when nothing is configured. That fallback
 * is deliberate: it means the entire subscription lifecycle — invoice, ledger
 * fee row, entitlement, dunning — is exercisable before any vendor account
 * exists, rather than the feature being untestable until someone finishes a KYC
 * form.
 */
export function subscriptionProviderFor(
  currency: Currency,
  line: ProductLine,
): SubscriptionProvider {
  if (line === "offer" && paddle.isConfigured()) return paddle;
  const native = currency === "INR" ? razorpaySubscriptions : stripeSubscriptions;
  if (native.isConfigured()) return native;
  return manualSubscriptions;
}

export function subscriptionProviderByName(name: string): SubscriptionProvider | null {
  return ALL.find((p) => p.name === name) ?? null;
}

export { razorpaySubscriptions, stripeSubscriptions, paddle, manualSubscriptions };

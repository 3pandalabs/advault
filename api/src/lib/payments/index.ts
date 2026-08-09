import "dotenv/config";
import type { Currency } from "../pricing/index.js";
import { razorpay } from "./razorpay.js";
import { stripe } from "./stripe.js";
import { manual } from "./manual.js";

// Payments, behind one interface so the rest of the API never knows which
// provider handled a currency.
//
// Routing is by CURRENCY, not by user preference: Razorpay is the practical
// rail for Indian businesses (UPI and netbanking, which is how most SMBs
// actually pay — card-only would exclude a large share of them), and Stripe
// handles USD.

// `add_on` is a one-off purchase of a produced artefact (the cinematic ad),
// as distinct from `topup`, which buys nothing and only moves money into the
// wallet to be spent at Google later. The difference matters at refund time:
// an unspent topup is still the advertiser's money sitting in a ledger, while
// an add_on that failed to produce is money taken for something never
// delivered.
export type PaymentPurpose = "topup" | "creation_fee" | "subscription" | "add_on";

export type CheckoutRequest = {
  paymentId: string;
  amountMinor: number;
  currency: Currency;
  purpose: PaymentPurpose;
  userEmail: string;
  returnUrl: string;
};

export type CheckoutSession = {
  /** Where to send the browser, or null for providers rendered client-side. */
  redirectUrl: string | null;
  /** Opaque data the frontend widget needs (Razorpay order id, Stripe client secret). */
  clientPayload: Record<string, unknown>;
  providerRef: string;
};

export type WebhookResult = {
  /** Our payments.id, recovered from provider metadata. */
  paymentId: string;
  providerRef: string;
  amountMinor: number;
  currency: Currency;
  status: "paid" | "failed" | "cancelled";
  raw: unknown;
};

export interface PaymentProvider {
  readonly name: "razorpay" | "stripe" | "manual";
  isConfigured(): boolean;
  createCheckout(req: CheckoutRequest): Promise<CheckoutSession>;
  /**
   * Verifies the signature and parses the event.
   *
   * MUST return null for anything that fails verification. This is the trust
   * boundary of the entire billing system: a webhook body is attacker-supplied
   * until its signature is checked, and an unverified "paid" event is free
   * money. Never parse first and verify later.
   */
  verifyWebhook(rawBody: string, headers: Record<string, string | undefined>): WebhookResult | null;
}

const PROVIDERS: Record<Currency, PaymentProvider> = {
  INR: razorpay,
  USD: stripe,
};

/**
 * Provider for a currency, falling back to the manual provider when the real
 * one has no credentials. That fallback is deliberate: it means the whole
 * billing flow — checkout row, ledger credit, launch guard — is exercisable
 * before any vendor account exists, instead of the feature being untestable
 * until someone finishes a KYC form.
 */
export function providerFor(currency: Currency): PaymentProvider {
  const p = PROVIDERS[currency];
  return p.isConfigured() ? p : manual;
}

export function providerByName(name: string): PaymentProvider | null {
  return [razorpay, stripe, manual].find((p) => p.name === name) ?? null;
}

export { razorpay, stripe, manual };

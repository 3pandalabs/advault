import { createHmac, timingSafeEqual } from "node:crypto";
import { isCurrency } from "../../pricing/index.js";
import { internalStripeMetadata, isUndeliverableEmail } from "../../testMode/policy.js";
import type {
  SubscriptionCheckout,
  SubscriptionCheckoutRequest,
  SubscriptionEvent,
  SubscriptionProvider,
} from "./index.js";

// Stripe Billing — the direct USD rail.
//
// Implemented against the REST API with fetch and form encoding rather than the
// SDK, matching lib/payments/stripe.ts: Stripe's API is form-encoded, the SDK
// would still leave the signature check below to be written by hand, and the
// renderer image would carry a dependency it never uses.

const SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const API = "https://api.stripe.com/v1";

const PRICE_IDS: Record<string, string | undefined> = {
  "us-offer": process.env.STRIPE_PRICE_US_OFFER,
  "us-managed": process.env.STRIPE_PRICE_US_MANAGED,
  "us-evergreen": process.env.STRIPE_PRICE_US_EVERGREEN,
};

/**
 * Stripe signs `${timestamp}.${rawBody}` and sends
 * `t=<ts>,v1=<hex>[,v1=<hex>]`. Multiple v1 values appear during a secret
 * rotation, so any match is a pass.
 */
function verifySignature(rawBody: string, header: string | undefined): boolean {
  if (!header || !WEBHOOK_SECRET) return false;

  const parts = header.split(",").map((kv) => kv.split("="));
  const ts = parts.find((p) => p[0] === "t")?.[1];
  const signatures = parts.filter((p) => p[0] === "v1").map((p) => p[1]);
  if (!ts || signatures.length === 0) return false;

  // Reject replays of a captured webhook. Stripe's own tolerance is 5 minutes.
  const age = Math.abs(Date.now() / 1000 - Number(ts));
  if (!Number.isFinite(age) || age > 300) return false;

  const expected = createHmac("sha256", WEBHOOK_SECRET).update(`${ts}.${rawBody}`).digest("hex");
  const b = Buffer.from(expected);
  return signatures.some((s) => {
    const a = Buffer.from(s);
    return a.length === b.length && timingSafeEqual(a, b);
  });
}

/**
 * The subscription's price. Normally the plan's fixed Stripe price id; in
 * test mode an inline monthly price for amountMinor (the $0.50 test price),
 * so no test price object has to exist in Stripe.
 */
export function stripeSubscriptionLine(req: SubscriptionCheckoutRequest): Record<string, string> {
  if (req.testMode) {
    return {
      "line_items[0][price_data][currency]": req.currency.toLowerCase(),
      "line_items[0][price_data][unit_amount]": String(req.amountMinor),
      "line_items[0][price_data][recurring][interval]": "month",
      "line_items[0][price_data][product_data][name]": "AdVault plan (test)",
    };
  }
  const priceId = PRICE_IDS[req.planKey];
  if (!priceId) throw new Error(`No Stripe price configured for ${req.planKey}`);
  return { "line_items[0][price]": priceId };
}

export const stripeSubscriptions: SubscriptionProvider = {
  name: "stripe",

  isConfigured() {
    return Boolean(SECRET_KEY && WEBHOOK_SECRET);
  },

  async createCheckout(req: SubscriptionCheckoutRequest): Promise<SubscriptionCheckout> {
    const form = new URLSearchParams({
      mode: "subscription",
      ...stripeSubscriptionLine(req),
      "line_items[0][quantity]": "1",
      // A test customer's *.invalid address (0030) is left off; Stripe asks for one.
      ...(isUndeliverableEmail(req.userEmail) ? {} : { customer_email: req.userEmail }),
      success_url: `${req.returnUrl}?subscribed=1`,
      cancel_url: req.returnUrl,
      // Set on the Checkout Session AND on the subscription it creates, so both
      // the first payment and every renewal carry our ids back to us.
      "metadata[subscription_id]": req.subscriptionId,
      "metadata[invoice_id]": req.invoiceId,
      "subscription_data[metadata][subscription_id]": req.subscriptionId,
      "subscription_data[metadata][invoice_id]": req.invoiceId,
      // The Stripe account is shared by every 3PandaLabs app; see stripeRouting.ts.
      "metadata[app]": "advault",
      "subscription_data[metadata][app]": "advault",
      // Admin "Test as customer": a $0.50 test subscription, not revenue.
      ...(req.testMode ? { "metadata[test_mode]": "1", "subscription_data[metadata][test_mode]": "1" } : {}),
      // 3PandaLabs' own account (0032): full price, the org paying itself.
      ...internalStripeMetadata(req),
      ...internalStripeMetadata(req, "subscription_data[metadata]"),
      // The included first month (0038): $0 today, card saved, first charge
      // at trial_end, and only if an ad is still running then.
      ...stripeTrialFields(req.trialEnd),
    });

    const res = await fetch(`${API}/checkout/sessions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${SECRET_KEY}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form,
    });

    if (!res.ok) {
      throw new Error(`Stripe session failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    }

    const session = (await res.json()) as { id: string; url?: string };
    return {
      redirectUrl: session.url ?? null,
      clientPayload: { sessionId: session.id },
      providerRef: session.id,
    };
  },

  verifyWebhook(rawBody, headers): SubscriptionEvent | null {
    if (!verifySignature(rawBody, headers["stripe-signature"])) return null;

    let event: {
      type?: string;
      data?: { object?: Record<string, unknown> };
    };
    try {
      event = JSON.parse(rawBody);
    } catch {
      return null;
    }

    const obj = event.data?.object ?? {};
    // Renewal invoices carry our ids under subscription_details.metadata
    // (parent.subscription_details on API versions from 2025-03-31); the
    // first one carries them at the top level. Checking all of them is what
    // makes month two behave like month one.
    const parentDetails = (
      obj.parent as { subscription_details?: { metadata?: Record<string, string>; subscription?: unknown } } | undefined
    )?.subscription_details;
    const meta = {
      ...((obj.metadata ?? {}) as Record<string, string>),
      ...((parentDetails?.metadata ?? {}) as Record<string, string>),
      ...(((obj.subscription_details as { metadata?: Record<string, string> } | undefined)
        ?.metadata ?? {}) as Record<string, string>),
    };

    switch (event.type) {
      case "invoice.paid":
      case "checkout.session.completed": {
        const invoiceId = meta.invoice_id;
        const currency = String(obj.currency ?? "").toUpperCase();
        const amountMinor = Number(obj.amount_paid ?? obj.amount_total);
        if (!invoiceId || !isCurrency(currency) || !Number.isFinite(amountMinor)) return null;
        return {
          kind: "paid",
          invoiceId,
          externalRef: String(obj.id),
          amountMinor,
          currency,
          raw: event,
          firstPayment:
            event.type === "checkout.session.completed" || obj.billing_reason === "subscription_create",
          providerSubscriptionRef: stripeIdOf(obj.subscription) ?? stripeIdOf(parentDetails?.subscription),
          providerCustomerRef: stripeIdOf(obj.customer),
        };
      }
      case "invoice.payment_failed": {
        const invoiceId = meta.invoice_id;
        if (!invoiceId) return null;
        return { kind: "failed", invoiceId, reason: "stripe:invoice.payment_failed", raw: event };
      }
      case "customer.subscription.deleted": {
        const subscriptionId = meta.subscription_id;
        if (!subscriptionId) return null;
        return { kind: "canceled", subscriptionId, raw: event };
      }
      default:
        return { kind: "ignored" };
    }
  },
};

/** A Stripe reference that may arrive as an id string or an expanded object. */
export function stripeIdOf(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string") return (v as { id: string }).id;
  return null;
}

// ---------------------------------------------------------------------------
// The plan follows the running ad (2026-11-19, lib/planBilling).
//
// Stopping is `cancel_at_period_end`, not `pause_collection`: the customer has
// paid for the period, the ad may come back inside it (then it is simply
// un-cancelled, no second charge), and if it does not the subscription ends at
// the period end and Stripe sends customer.subscription.deleted, which the
// existing lifecycle already handles. A restart after that is a NEW
// subscription on the same Stripe customer and saved card (a new period,
// charged then). pause_collection would keep one subscription "active" for
// ever with voided invoices, which our own period / entitlement model, MRR and
// the renewal sweep would all have to learn to read as "not paying".
// ---------------------------------------------------------------------------

/** `subscription_data[trial_end]` for the included first month. */
export function stripeTrialFields(trialEnd: Date | null | undefined): Record<string, string> {
  if (!trialEnd) return {};
  return { "subscription_data[trial_end]": String(Math.floor(trialEnd.getTime() / 1000)) };
}

export class StripeApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(message);
  }
}

async function stripeCall<T>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  form?: Record<string, string>,
): Promise<T> {
  if (!SECRET_KEY) throw new StripeApiError(0, "not_configured", "Stripe is not configured");
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${SECRET_KEY}`,
      ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
    },
    body: form ? new URLSearchParams(form) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    let code: string | null = null;
    try {
      code = (JSON.parse(text) as { error?: { code?: string } }).error?.code ?? null;
    } catch {
      /* not JSON */
    }
    throw new StripeApiError(res.status, code, `Stripe ${method} ${path} failed: ${res.status} ${text.slice(0, 200)}`);
  }
  return JSON.parse(text) as T;
}

type StripeSubscriptionObject = {
  id: string;
  status: string;
  customer: string;
  cancel_at_period_end: boolean;
  default_payment_method: string | null;
  items?: { data?: { price?: { id?: string; product?: string } }[] };
};

/** The sub_ and cus_ a completed subscription checkout created (older rows stored only the cs_). */
export async function stripeSessionRefs(
  sessionId: string,
): Promise<{ subscription: string | null; customer: string | null }> {
  const s = await stripeCall<{ subscription: unknown; customer: unknown }>("GET", `/checkout/sessions/${sessionId}`);
  return { subscription: stripeIdOf(s.subscription), customer: stripeIdOf(s.customer) };
}

/** Stop at the end of the paid period (true), or take that back (false). */
export async function stripeSetCancelAtPeriodEnd(subscriptionRef: string, cancel: boolean): Promise<StripeSubscriptionObject> {
  return stripeCall<StripeSubscriptionObject>("POST", `/subscriptions/${subscriptionRef}`, {
    cancel_at_period_end: cancel ? "true" : "false",
  });
}

/** Ends a subscription now (account deletion). */
export async function stripeCancelNow(subscriptionRef: string): Promise<void> {
  await stripeCall("DELETE", `/subscriptions/${subscriptionRef}`);
}

/** Expires an abandoned checkout so it can no longer be completed. */
export async function stripeExpireSession(sessionId: string): Promise<void> {
  await stripeCall("POST", `/checkout/sessions/${sessionId}/expire`, {});
}

/**
 * The form for a restarted plan: the same customer and the card the previous
 * plan used, charged NOW (`error_if_incomplete`: a decline, or a card that
 * needs the customer present, fails the call and creates nothing). Pure, tested.
 */
export function stripeRestartForm(args: {
  customerRef: string;
  paymentMethod: string;
  priceId: string | null;
  /** Test mode / no price id: an inline monthly price on this product. */
  productId: string | null;
  testMode: boolean;
  amountMinor: number;
  currency: string;
  subscriptionId: string;
  invoiceId: string;
  internal?: boolean;
  internalLabel?: string | null;
}): Record<string, string> {
  const line: Record<string, string> =
    args.testMode || !args.priceId
      ? {
          "items[0][price_data][currency]": args.currency.toLowerCase(),
          "items[0][price_data][unit_amount]": String(args.amountMinor),
          "items[0][price_data][recurring][interval]": "month",
          "items[0][price_data][product]": args.productId ?? "",
        }
      : { "items[0][price]": args.priceId };
  return {
    customer: args.customerRef,
    default_payment_method: args.paymentMethod,
    payment_behavior: "error_if_incomplete",
    off_session: "true",
    ...line,
    "metadata[subscription_id]": args.subscriptionId,
    "metadata[invoice_id]": args.invoiceId,
    "metadata[app]": "advault",
    ...(args.testMode ? { "metadata[test_mode]": "1" } : {}),
    ...internalStripeMetadata(args),
  };
}

export type StripeRestart =
  | { ok: true; subscriptionRef: string; customerRef: string; invoiceRef: string | null; amountPaidMinor: number }
  | { ok: false; reason: "no_saved_card" | "card_declined" | "stripe_error"; detail?: string };

/**
 * Starts a new plan subscription off-session with the card the previous one
 * used. Never throws.
 */
export async function stripeRestartOffSession(args: {
  previousSubscriptionRef: string;
  planKey: string;
  testMode: boolean;
  amountMinor: number;
  currency: string;
  subscriptionId: string;
  invoiceId: string;
  internal?: boolean;
  internalLabel?: string | null;
}): Promise<StripeRestart> {
  try {
    const prev = await stripeCall<StripeSubscriptionObject>("GET", `/subscriptions/${args.previousSubscriptionRef}`);
    let paymentMethod = stripeIdOf(prev.default_payment_method);
    if (!paymentMethod) {
      const cus = await stripeCall<{ invoice_settings?: { default_payment_method?: unknown } }>(
        "GET",
        `/customers/${stripeIdOf(prev.customer)}`,
      );
      paymentMethod = stripeIdOf(cus.invoice_settings?.default_payment_method);
    }
    if (!paymentMethod) return { ok: false, reason: "no_saved_card" };
    const priceId = PRICE_IDS[args.planKey] ?? null;
    const productId = stripeIdOf(prev.items?.data?.[0]?.price?.product);
    if ((args.testMode || !priceId) && !productId) {
      return { ok: false, reason: "stripe_error", detail: "previous plan has no product to reuse" };
    }

    const created = await stripeCall<{
      id: string;
      status: string;
      customer: unknown;
      latest_invoice: unknown;
    }>(
      "POST",
      "/subscriptions",
      stripeRestartForm({ ...args, customerRef: stripeIdOf(prev.customer)!, paymentMethod, priceId, productId }),
    );
    if (created.status !== "active") {
      // error_if_incomplete makes this unreachable; never leave one half made.
      await stripeCancelNow(created.id).catch(() => undefined);
      return { ok: false, reason: "card_declined", detail: created.status };
    }
    const inv = created.latest_invoice as { amount_paid?: number } | string | null;
    return {
      ok: true,
      subscriptionRef: created.id,
      customerRef: stripeIdOf(created.customer) ?? stripeIdOf(prev.customer)!,
      invoiceRef: stripeIdOf(inv),
      amountPaidMinor: typeof inv === "object" && inv && typeof inv.amount_paid === "number" ? inv.amount_paid : args.amountMinor,
    };
  } catch (err) {
    if (err instanceof StripeApiError && err.status === 402) {
      return { ok: false, reason: "card_declined", detail: err.code ?? undefined };
    }
    return { ok: false, reason: "stripe_error", detail: String(err).slice(0, 300) };
  }
}

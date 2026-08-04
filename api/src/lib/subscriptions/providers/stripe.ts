import { createHmac, timingSafeEqual } from "node:crypto";
import { isCurrency } from "../../pricing/index.js";
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

export const stripeSubscriptions: SubscriptionProvider = {
  name: "stripe",

  isConfigured() {
    return Boolean(SECRET_KEY && WEBHOOK_SECRET);
  },

  async createCheckout(req: SubscriptionCheckoutRequest): Promise<SubscriptionCheckout> {
    const priceId = PRICE_IDS[req.planKey];
    if (!priceId) throw new Error(`No Stripe price configured for ${req.planKey}`);

    const form = new URLSearchParams({
      mode: "subscription",
      "line_items[0][price]": priceId,
      "line_items[0][quantity]": "1",
      customer_email: req.userEmail,
      success_url: `${req.returnUrl}?subscribed=1`,
      cancel_url: req.returnUrl,
      // Set on the Checkout Session AND on the subscription it creates, so both
      // the first payment and every renewal carry our ids back to us.
      "metadata[subscription_id]": req.subscriptionId,
      "metadata[invoice_id]": req.invoiceId,
      "subscription_data[metadata][subscription_id]": req.subscriptionId,
      "subscription_data[metadata][invoice_id]": req.invoiceId,
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
    // Renewal invoices carry our ids under subscription_details.metadata;
    // the first one carries them at the top level. Checking both is what makes
    // month two behave like month one.
    const meta = {
      ...((obj.metadata ?? {}) as Record<string, string>),
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

import { createHmac, timingSafeEqual } from "node:crypto";
import { isCurrency } from "../../pricing/index.js";
import type {
  SubscriptionCheckout,
  SubscriptionCheckoutRequest,
  SubscriptionEvent,
  SubscriptionProvider,
} from "./index.js";

// Razorpay Subscriptions — the direct INR rail for the managed line.
//
// Distinct from lib/payments/razorpay.ts, which creates one-off Orders. A
// subscription needs a mandate (UPI AutoPay, e-NACH or a card mandate) and
// emits its own event family, so it is a different object against a different
// endpoint. Sharing the module would have meant one file where half the
// functions apply.
//
// UPI AutoPay matters more here than the card path: most Indian small
// businesses do not want a card on file, and a mandate they approve in their
// own UPI app is the difference between a recurring product and a monthly
// chase.

const KEY_ID = process.env.RAZORPAY_KEY_ID;
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;
const API = "https://api.razorpay.com/v1";

// Razorpay plans are created in their dashboard and referenced by id. lib/pricing
// remains the source of truth for the amount we charge; these only say which
// Razorpay object collects it. A drift between the two surfaces as the amount
// mismatch the webhook handler refuses.
const PLAN_IDS: Record<string, string | undefined> = {
  "in-offer": process.env.RAZORPAY_PLAN_IN_OFFER,
  "in-managed": process.env.RAZORPAY_PLAN_IN_MANAGED,
};

// 10 years of monthly cycles. Razorpay requires a finite count, and a number
// this large is the closest thing to "until cancelled" the API offers.
const TOTAL_CYCLES = 120;

export const razorpaySubscriptions: SubscriptionProvider = {
  name: "razorpay",

  isConfigured() {
    return Boolean(KEY_ID && KEY_SECRET && WEBHOOK_SECRET);
  },

  async createCheckout(req: SubscriptionCheckoutRequest): Promise<SubscriptionCheckout> {
    const planId = PLAN_IDS[req.planKey];
    if (!planId) throw new Error(`No Razorpay plan configured for ${req.planKey}`);

    const auth = Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString("base64");
    const res = await fetch(`${API}/subscriptions`, {
      method: "POST",
      headers: { authorization: `Basic ${auth}`, "content-type": "application/json" },
      body: JSON.stringify({
        plan_id: planId,
        total_count: TOTAL_CYCLES,
        customer_notify: 1,
        // Carried onto every payment event for the life of the mandate.
        notes: {
          subscription_id: req.subscriptionId,
          invoice_id: req.invoiceId,
          plan_key: req.planKey,
        },
      }),
    });

    if (!res.ok) {
      throw new Error(
        `Razorpay subscription failed: ${res.status} ${(await res.text()).slice(0, 200)}`,
      );
    }

    const sub = (await res.json()) as { id: string; short_url?: string };
    return {
      redirectUrl: sub.short_url ?? null,
      clientPayload: { keyId: KEY_ID, subscriptionId: sub.id },
      providerRef: sub.id,
    };
  },

  verifyWebhook(rawBody, headers): SubscriptionEvent | null {
    const signature = headers["x-razorpay-signature"];
    if (!signature || !WEBHOOK_SECRET) return null;

    // HMAC-SHA256 over the RAW bytes. A re-serialised body has different
    // whitespace and key order and never matches.
    const expected = createHmac("sha256", WEBHOOK_SECRET).update(rawBody).digest("hex");
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

    let event: {
      event?: string;
      payload?: {
        payment?: { entity?: Record<string, unknown> };
        subscription?: { entity?: Record<string, unknown> };
      };
    };
    try {
      event = JSON.parse(rawBody);
    } catch {
      return null;
    }

    const payment = event.payload?.payment?.entity;
    const subscription = event.payload?.subscription?.entity;
    const notes = ((payment?.notes ?? subscription?.notes) ?? {}) as Record<string, string>;

    switch (event.event) {
      case "subscription.charged": {
        const currency = String(payment?.currency ?? "");
        const invoiceId = notes.invoice_id;
        if (!invoiceId || !isCurrency(currency)) return null;
        return {
          kind: "paid",
          invoiceId,
          externalRef: String(payment?.id),
          // The provider's figure, not ours — this is what was actually taken.
          amountMinor: Number(payment?.amount),
          currency,
          raw: event,
        };
      }
      case "subscription.halted":
      case "payment.failed": {
        const invoiceId = notes.invoice_id;
        if (!invoiceId) return null;
        return { kind: "failed", invoiceId, reason: `razorpay:${event.event}`, raw: event };
      }
      case "subscription.cancelled": {
        const subscriptionId = notes.subscription_id;
        if (!subscriptionId) return null;
        return { kind: "canceled", subscriptionId, raw: event };
      }
      default:
        return { kind: "ignored" };
    }
  },
};

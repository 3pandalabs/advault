import { createHmac, timingSafeEqual } from "node:crypto";
import type { CheckoutRequest, CheckoutSession, PaymentProvider, WebhookResult } from "./index.js";
import { isCurrency } from "../pricing/index.js";

// Razorpay — the INR rail. Chosen over card-only providers because UPI and
// netbanking are how most Indian small businesses actually pay.
//
// Implemented against the REST API with fetch rather than the SDK: two
// endpoints and one HMAC check do not justify a dependency, and the SDK would
// still leave the signature verification below to be written by hand.

const KEY_ID = process.env.RAZORPAY_KEY_ID;
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;
const API = "https://api.razorpay.com/v1";

export const razorpay: PaymentProvider = {
  name: "razorpay",

  isConfigured() {
    return Boolean(KEY_ID && KEY_SECRET && WEBHOOK_SECRET);
  },

  async createCheckout(req: CheckoutRequest): Promise<CheckoutSession> {
    const auth = Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString("base64");
    const res = await fetch(`${API}/orders`, {
      method: "POST",
      headers: { authorization: `Basic ${auth}`, "content-type": "application/json" },
      body: JSON.stringify({
        // Razorpay takes paise — already our minor unit, so no conversion. That
        // is precisely why money is stored in minor units everywhere.
        amount: req.amountMinor,
        currency: req.currency,
        receipt: req.paymentId,
        // Carried through to the webhook. This is how a verified event is tied
        // back to OUR payments row — never by amount or by user, which are not
        // unique.
        notes: { payment_id: req.paymentId, purpose: req.purpose },
      }),
    });

    if (!res.ok) {
      throw new Error(`Razorpay order failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    }

    const order = (await res.json()) as { id: string };
    return {
      // Razorpay Checkout is a client-side widget, so there is nothing to
      // redirect to — the frontend opens it with these values.
      redirectUrl: null,
      clientPayload: { keyId: KEY_ID, orderId: order.id, amount: req.amountMinor, currency: req.currency },
      providerRef: order.id,
    };
  },

  verifyWebhook(rawBody, headers): WebhookResult | null {
    const signature = headers["x-razorpay-signature"];
    if (!signature || !WEBHOOK_SECRET) return null;

    // HMAC-SHA256 over the RAW body. It must be the exact bytes received — a
    // parsed-and-restringified body has different whitespace and key order and
    // will never match, which is why the route registers a raw-body parser for
    // this path instead of letting Fastify JSON-parse it first.
    const expected = createHmac("sha256", WEBHOOK_SECRET).update(rawBody).digest("hex");
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

    // Only parse AFTER the signature holds.
    let event: {
      event?: string;
      payload?: { payment?: { entity?: Record<string, unknown> } };
    };
    try {
      event = JSON.parse(rawBody);
    } catch {
      return null;
    }

    const entity = event.payload?.payment?.entity;
    if (!entity) return null;

    const notes = (entity.notes ?? {}) as Record<string, string>;
    const paymentId = notes.payment_id;
    const currency = String(entity.currency ?? "");
    if (!paymentId || !isCurrency(currency)) return null;

    const status =
      event.event === "payment.captured"
        ? "paid"
        : event.event === "payment.failed"
          ? "failed"
          : "cancelled";

    return {
      paymentId,
      providerRef: String(entity.id),
      // Trust the provider's amount, not the client's — the browser could have
      // asked for any figure; this is what was actually captured.
      amountMinor: Number(entity.amount),
      currency,
      status,
      raw: event,
    };
  },
};

import { createHmac, timingSafeEqual } from "node:crypto";
import type { CheckoutRequest, CheckoutSession, PaymentProvider, WebhookResult } from "./index.js";
import { isCurrency } from "../pricing/index.js";

// Stripe — the USD rail. REST + fetch for the same reason as Razorpay: one
// endpoint and one signature check.

const SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const API = "https://api.stripe.com/v1";

// Stripe rejects a timestamp outside its tolerance to stop an attacker
// replaying a captured webhook later. Five minutes is Stripe's own default.
const TOLERANCE_SECONDS = 300;

export const stripe: PaymentProvider = {
  name: "stripe",

  isConfigured() {
    return Boolean(SECRET_KEY && WEBHOOK_SECRET);
  },

  async createCheckout(req: CheckoutRequest): Promise<CheckoutSession> {
    // Stripe's API is form-encoded, not JSON.
    const body = new URLSearchParams({
      mode: "payment",
      success_url: `${req.returnUrl}?status=success`,
      cancel_url: `${req.returnUrl}?status=cancelled`,
      customer_email: req.userEmail,
      "line_items[0][quantity]": "1",
      "line_items[0][price_data][currency]": req.currency.toLowerCase(),
      "line_items[0][price_data][unit_amount]": String(req.amountMinor),
      "line_items[0][price_data][product_data][name]":
        req.purpose === "topup" ? "AdVault ad balance top-up" : "AdVault campaign fee",
      // Round-trips to the webhook. Same reasoning as Razorpay's notes: this is
      // the only reliable link back to our payments row.
      "metadata[payment_id]": req.paymentId,
      "metadata[purpose]": req.purpose,
    });

    const res = await fetch(`${API}/checkout/sessions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${SECRET_KEY}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
    });

    if (!res.ok) {
      throw new Error(`Stripe session failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    }

    const session = (await res.json()) as { id: string; url: string };
    return { redirectUrl: session.url, clientPayload: {}, providerRef: session.id };
  },

  verifyWebhook(rawBody, headers): WebhookResult | null {
    const header = headers["stripe-signature"];
    if (!header || !WEBHOOK_SECRET) return null;

    // Header is `t=<ts>,v1=<sig>,v1=<sig>…` — multiple v1 values appear during
    // a secret rotation, and any one matching is valid.
    const parts = Object.fromEntries(
      header.split(",").map((p) => {
        const i = p.indexOf("=");
        return [p.slice(0, i), p.slice(i + 1)];
      }),
    ) as Record<string, string>;
    const timestamp = parts.t;
    if (!timestamp) return null;

    // Reject stale events before doing crypto — a valid signature on a
    // week-old event is still a replay.
    if (Math.abs(Date.now() / 1000 - Number(timestamp)) > TOLERANCE_SECONDS) return null;

    const signed = `${timestamp}.${rawBody}`;
    const expected = createHmac("sha256", WEBHOOK_SECRET).update(signed).digest("hex");
    const candidates = header
      .split(",")
      .filter((p) => p.startsWith("v1="))
      .map((p) => p.slice(3));

    const ok = candidates.some((c) => {
      const a = Buffer.from(c);
      const b = Buffer.from(expected);
      return a.length === b.length && timingSafeEqual(a, b);
    });
    if (!ok) return null;

    let event: { type?: string; data?: { object?: Record<string, unknown> } };
    try {
      event = JSON.parse(rawBody);
    } catch {
      return null;
    }

    const obj = event.data?.object;
    if (!obj) return null;

    const metadata = (obj.metadata ?? {}) as Record<string, string>;
    const paymentId = metadata.payment_id;
    const currency = String(obj.currency ?? "").toUpperCase();
    if (!paymentId || !isCurrency(currency)) return null;

    const status =
      event.type === "checkout.session.completed"
        ? "paid"
        : event.type === "checkout.session.expired"
          ? "cancelled"
          : "failed";

    return {
      paymentId,
      providerRef: String(obj.id),
      amountMinor: Number(obj.amount_total ?? 0),
      currency,
      status,
      raw: event,
    };
  },
};

import type { FastifyInstance } from "fastify";
import { routeStripeEvent } from "../lib/payments/stripeRouting.js";

// AdVault's single Stripe webhook endpoint. See lib/payments/stripeRouting.ts.
// It re-dispatches the untouched raw body and Stripe-Signature header to the
// existing handler, which verifies the signature exactly as if Stripe had
// called it directly; nothing here acts on an unverified event.
const TARGETS = {
  payments: "/webhooks/payments/stripe",
  purchases: "/webhooks/purchases/stripe",
  subscriptions: "/webhooks/subscriptions/stripe",
} as const;

export async function stripeWebhookRoutes(app: FastifyInstance) {
  app.post("/webhooks/stripe", { config: { rawBody: true } }, async (req, reply) => {
    const raw = (req as { rawBody?: string }).rawBody;
    if (!raw) return reply.code(400).send({ error: "missing_raw_body" });

    let event: Parameters<typeof routeStripeEvent>[0];
    try {
      event = JSON.parse(raw);
    } catch {
      return reply.code(400).send({ error: "invalid_json" });
    }

    const route = routeStripeEvent(event);
    if (route === "ignore") return reply.code(200).send({ ok: true, ignored: true });

    const res = await app.inject({
      method: "POST",
      url: TARGETS[route],
      payload: raw,
      headers: {
        "content-type": "application/json",
        "stripe-signature": String(req.headers["stripe-signature"] ?? ""),
      },
    });
    return reply.code(res.statusCode).header("content-type", "application/json").send(res.body);
  });
}

// Which AdVault handler a Stripe event belongs to.
//
// Stripe gives each webhook endpoint its own signing secret, and AdVault reads
// one (STRIPE_WEBHOOK_SECRET). So AdVault registers ONE endpoint,
// /webhooks/stripe, and this decides which of the three handlers (top-ups,
// one-off purchases, subscriptions) gets each event. The handler still
// verifies the signature; this only routes.
//
// The 3PandaLabs Stripe account is shared by every product, and Stripe sends
// an endpoint every event type it subscribes to, so anything another app
// created (metadata.app set to something else) or that no handler wants is
// answered 200 and dropped. Answering an error instead makes Stripe retry for
// days and eventually disable the endpoint.

export const STRIPE_APP = "advault";

export type StripeRoute = "payments" | "purchases" | "subscriptions" | "ignore";

type StripeObject = {
  mode?: string;
  metadata?: Record<string, string> | null;
  subscription_details?: { metadata?: Record<string, string> | null } | null;
};

export function routeStripeEvent(event: { type?: string; data?: { object?: StripeObject } }): StripeRoute {
  const type = event.type ?? "";
  const obj = event.data?.object ?? {};
  const meta = { ...(obj.metadata ?? {}), ...(obj.subscription_details?.metadata ?? {}) };

  // Created by another 3PandaLabs app. Older AdVault sessions have no app tag.
  if (meta.app && meta.app !== STRIPE_APP) return "ignore";

  if (type.startsWith("invoice.") || type.startsWith("customer.subscription.")) {
    return meta.subscription_id || meta.invoice_id ? "subscriptions" : "ignore";
  }
  if (type.startsWith("checkout.session.")) {
    if (obj.mode === "subscription" || meta.invoice_id) return "subscriptions";
    if (!meta.payment_id) return "ignore";
    return meta.purpose === "add_on" ? "purchases" : "payments";
  }
  return "ignore";
}

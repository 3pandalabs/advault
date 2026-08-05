import type {
  SubscriptionCheckout,
  SubscriptionCheckoutRequest,
  SubscriptionEvent,
  SubscriptionProvider,
} from "./index.js";

// The no-vendor fallback, mirroring lib/payments/manual.ts.
//
// It exists so the whole subscription lifecycle — invoice row, ledger `fee`
// entry, service entitlement, dunning ladder, renewal sweep — can be exercised
// end to end before any Paddle, Razorpay or Stripe account exists. Without it
// the revenue path would be untestable until someone finished a KYC form, which
// is precisely how AdVault shipped v2's AI adapters as dead code: the only
// proof they worked was that nothing crashed.
//
// It CANNOT move money. `createCheckout` returns no redirect and no mandate,
// and `verifyWebhook` always returns null so there is no unsigned path to a
// paid state. The only way a manual subscription becomes active is an
// admin-only route, which is deliberately the same shape as the manual wallet
// credit: an operator action with an audit trail, never an anonymous one.

export const manualSubscriptions: SubscriptionProvider = {
  name: "manual",

  isConfigured() {
    return true;
  },

  async createCheckout(req: SubscriptionCheckoutRequest): Promise<SubscriptionCheckout> {
    return {
      redirectUrl: null,
      clientPayload: {
        manual: true,
        note: "No subscription provider is configured. An admin must mark this invoice paid.",
        invoiceId: req.invoiceId,
      },
      providerRef: `manual:${req.subscriptionId}`,
    };
  },

  verifyWebhook(): SubscriptionEvent | null {
    // No signature, no secret, no trust. Never returns an event.
    return null;
  },
};

import { randomUUID } from "node:crypto";
import type { CheckoutRequest, CheckoutSession, PaymentProvider } from "./index.js";

// The fallback provider, used automatically when the real one for a currency
// has no credentials (see providerFor()).
//
// It exists so the entire billing path — checkout row, wallet credit, launch
// guard, auto-pause — is exercisable end to end before any vendor account
// exists. Without it, none of that logic could be tested until someone finished
// a Razorpay or Stripe onboarding form, and untested money code is exactly the
// code you do not want to first exercise in production.
//
// It CANNOT credit a wallet on its own. `createCheckout` returns a reference
// and nothing else; crediting requires an admin to call the explicit
// admin-credit route, which is behind requireAdmin. There is deliberately no
// path where an unauthenticated caller can conjure balance.
export const manual: PaymentProvider = {
  name: "manual",

  // Always "configured" — it is the thing that runs when nothing else is.
  isConfigured() {
    return true;
  },

  async createCheckout(req: CheckoutRequest): Promise<CheckoutSession> {
    return {
      redirectUrl: null,
      clientPayload: {
        manual: true,
        // Surfaced verbatim by the frontend so nobody mistakes a dev
        // environment for a working checkout.
        message:
          "No payment provider is configured for this currency. An administrator must credit this top-up manually.",
        amountMinor: req.amountMinor,
        currency: req.currency,
      },
      providerRef: `manual_${randomUUID()}`,
    };
  },

  // No webhook. There is no external system to hear from.
  verifyWebhook() {
    return null;
  },
};

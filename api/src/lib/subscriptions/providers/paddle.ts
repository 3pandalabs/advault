import { createHmac, timingSafeEqual } from "node:crypto";
import { isCurrency } from "../../pricing/index.js";
import type {
  SubscriptionCheckout,
  SubscriptionCheckoutRequest,
  SubscriptionEvent,
  SubscriptionProvider,
} from "./index.js";

// Paddle — the merchant-of-record rail.
//
// WHY THIS EXISTS, because it is not obvious from the code: Paddle is the
// SELLER of the offer subscription, not a gateway that moves our money. That
// single distinction is what lets AdVault sell to Indian small businesses with
// no Indian entity AND no Indian tax registration:
//
//   * A foreign company supplying online services to Indian consumers must
//     register for GST as an OIDAR provider from the FIRST rupee — there is no
//     turnover threshold the way there is for a domestic supplier — charge 18%
//     IGST, file GSTR-5A monthly (nil returns included), and appoint an
//     authorised representative in India. That is a real recurring cost, owed
//     before anyone has proven they will pay for anything.
//   * When Paddle is the merchant of record, that obligation is Paddle's. It
//     also handles EU VAT, US sales tax and the rest of the same problem.
//
// The cost is roughly 5% plus a per-transaction fee, against ~2–3% for a direct
// rail. That spread is the price of not owning a tax registration during the
// months when the only question that matters is whether anyone will subscribe.
//
// Once India is proven, the cheaper path is Razorpay's PA-CB cross-border
// licence plus our own OIDAR registration — see infra/ for that decision. The
// provider interface is the seam that makes swapping it a config change.

const API_KEY = process.env.PADDLE_API_KEY;
const WEBHOOK_SECRET = process.env.PADDLE_WEBHOOK_SECRET;
const API = process.env.PADDLE_API_URL ?? "https://api.paddle.com";

// Paddle prices are created in Paddle's own dashboard and referenced by id, so
// the price list lives in two places by necessity. lib/pricing stays the source
// of truth for what we CHARGE; these ids only say which Paddle object collects
// it. A mismatch shows up as an amount mismatch on the webhook, which is
// checked rather than reconciled.
const PRICE_IDS: Record<string, string | undefined> = {
  "in-offer": process.env.PADDLE_PRICE_IN_OFFER,
  "us-offer": process.env.PADDLE_PRICE_US_OFFER,
  "in-managed": process.env.PADDLE_PRICE_IN_MANAGED,
  "us-managed": process.env.PADDLE_PRICE_US_MANAGED,
};

/**
 * Signature format is `ts=<unix>;h1=<hex>`, and the signed payload is
 * `${ts}:${rawBody}` — NOT the body alone. Getting that wrong produces a
 * verification that fails uniformly and looks like a bad secret.
 */
function verifySignature(rawBody: string, header: string | undefined): boolean {
  if (!header || !WEBHOOK_SECRET) return false;

  const parts = Object.fromEntries(
    header.split(";").map((kv) => {
      const i = kv.indexOf("=");
      return [kv.slice(0, i), kv.slice(i + 1)];
    }),
  );
  const ts = parts.ts;
  const h1 = parts.h1;
  if (!ts || !h1) return false;

  // Reject stale signatures. Without this a captured webhook can be replayed
  // indefinitely; five minutes is Paddle's own recommended tolerance.
  const ageSeconds = Math.abs(Date.now() / 1000 - Number(ts));
  if (!Number.isFinite(ageSeconds) || ageSeconds > 300) return false;

  const expected = createHmac("sha256", WEBHOOK_SECRET).update(`${ts}:${rawBody}`).digest("hex");
  const a = Buffer.from(h1);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const paddle: SubscriptionProvider = {
  name: "paddle",

  isConfigured() {
    return Boolean(API_KEY && WEBHOOK_SECRET);
  },

  async createCheckout(req: SubscriptionCheckoutRequest): Promise<SubscriptionCheckout> {
    const priceId = PRICE_IDS[req.planKey];
    if (!priceId) throw new Error(`No Paddle price configured for plan ${req.planKey}`);

    const res = await fetch(`${API}/transactions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${API_KEY}`,
        "content-type": "application/json",
        "paddle-version": "1",
      },
      body: JSON.stringify({
        items: [{ price_id: priceId, quantity: 1 }],
        collection_mode: "automatic",
        customer: { email: req.userEmail },
        // Carried through to every webhook for this transaction and its
        // renewals. This is the only reliable link back to our own rows —
        // never the amount or the email, neither of which is unique.
        custom_data: {
          subscription_id: req.subscriptionId,
          invoice_id: req.invoiceId,
          plan_key: req.planKey,
        },
        checkout: { url: req.returnUrl },
      }),
    });

    if (!res.ok) {
      throw new Error(`Paddle transaction failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    }

    const body = (await res.json()) as {
      data?: { id?: string; checkout?: { url?: string } };
    };
    const id = body.data?.id;
    if (!id) throw new Error("Paddle returned no transaction id");

    return {
      redirectUrl: body.data?.checkout?.url ?? null,
      clientPayload: { transactionId: id },
      providerRef: id,
    };
  },

  verifyWebhook(rawBody, headers): SubscriptionEvent | null {
    if (!verifySignature(rawBody, headers["paddle-signature"])) return null;

    // Only parse AFTER the signature holds.
    let event: {
      event_type?: string;
      data?: {
        id?: string;
        status?: string;
        currency_code?: string;
        custom_data?: Record<string, string>;
        details?: { totals?: { grand_total?: string } };
      };
    };
    try {
      event = JSON.parse(rawBody);
    } catch {
      return null;
    }

    const data = event.data;
    const custom = data?.custom_data ?? {};
    const invoiceId = custom.invoice_id;
    const subscriptionId = custom.subscription_id;

    switch (event.event_type) {
      case "transaction.completed": {
        const currency = String(data?.currency_code ?? "");
        // Paddle reports totals as a decimal STRING in the minor unit already
        // ("999" is ₹9.99 worth of paise only if you assume — it is not). Their
        // grand_total is in the lowest denomination as a string, so Number() is
        // the conversion, and a non-finite result must fail closed.
        const amountMinor = Number(data?.details?.totals?.grand_total);
        if (!invoiceId || !isCurrency(currency) || !Number.isFinite(amountMinor)) return null;
        return {
          kind: "paid",
          invoiceId,
          externalRef: String(data?.id),
          amountMinor,
          currency,
          raw: event,
        };
      }
      case "transaction.payment_failed":
        if (!invoiceId) return null;
        return {
          kind: "failed",
          invoiceId,
          reason: `paddle:${data?.status ?? "payment_failed"}`,
          raw: event,
        };
      case "subscription.canceled":
        if (!subscriptionId) return null;
        return { kind: "canceled", subscriptionId, raw: event };
      default:
        // New Paddle event types appear without warning. Ignoring them returns
        // 200 and stops the retry storm a 500 would cause.
        return { kind: "ignored" };
    }
  },
};

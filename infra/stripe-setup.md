# Stripe setup (US)

One Stripe account for all of 3PandaLabs (the LLC); each app labels what it
creates with `metadata.app` and ignores everything else. AdVault's tag is
`advault`.

## 1. Account

stripe.com → sign up as **3PandaLabs LLC** (New Jersey, the LLC's EIN), payouts
to the Mercury checking account. Turn on a statement descriptor like
`3PANDALABS` and use the product name as the suffix where Stripe allows it.

## 2. Keys

Developers → API keys → **Create restricted key** "advault-api" with write access
to: Checkout Sessions, Customers, Subscriptions, Invoices, Prices (read),
Products (read). Never give the app the full secret key.

## 3. Prices

Product catalogue → Add product:

| Product | Price | Env var on `advault-api` |
|---|---|---|
| AdVault Keep it running | $19.00 USD, recurring monthly | `STRIPE_PRICE_US_EVERGREEN` |
| AdVault Managed | $79.00 USD, recurring monthly | `STRIPE_PRICE_US_MANAGED` (only if sold) |
| AdVault Monthly offer | $39.00 USD, recurring monthly | `STRIPE_PRICE_US_OFFER` (only if sold) |

One-off charges (the $19 ad, cinematic, top-ups) need no price object; the
checkout sets the amount.

## 4. Webhook — ONE endpoint

Developers → Webhooks → Add endpoint:

- URL: `https://api.advault.3pandalabs.com/webhooks/stripe`
- Events: `checkout.session.completed`, `checkout.session.expired`,
  `invoice.paid`, `invoice.payment_failed`, `customer.subscription.deleted`

Copy its **signing secret** into `STRIPE_WEBHOOK_SECRET`. Do not add the older
per-purpose URLs (`/webhooks/{payments,purchases,subscriptions}/stripe`) as
endpoints: each endpoint gets its own secret and the app reads only one.
`/webhooks/stripe` routes each event to the right handler
(`lib/payments/stripeRouting.ts`) and answers 200 to events from other apps.

## 5. Env on `advault-api` (Coolify)

`STRIPE_SECRET_KEY` (the restricted key), `STRIPE_WEBHOOK_SECRET`,
`STRIPE_PRICE_US_EVERGREEN`. Redeploy.

## 6. Test

Use test mode first: same steps with test keys, buy the $19 ad with card
`4242 4242 4242 4242`, and check the webhook shows 200 in the Stripe dashboard.

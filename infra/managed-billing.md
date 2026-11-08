# Managed billing: AdVault pays Google for the customer

Customers never touch Google or YouTube. AdVault creates their Google Ads
account under the MCC (641-518-4348), publishes their videos to the org channel
(@advaultads), and 3PandaLabs pays Google, recovering the money from the
customer's prepaid AdVault wallet.

**Google has no API that adds a payment method.** Until the MCC qualifies for
monthly invoicing, each new customer's account needs a card added by hand. That
is the one manual step, and it is the operator's, never the customer's.

## Right now: you also create the account (until $1,000 of spend)

Google refuses to let a new manager account create accounts — UI and API
alike — until an account linked under it has spent **over $1,000** with a clean
policy record (`CREATION_DENIED_INELIGIBLE_MCC`, since March 2025). AdVault
tries automatic creation first every time, and when Google refuses it falls
back to you:

1. The customer presses **Set up my ad account** and sees "being set up".
   AdVault gives them a reference code (e.g. `AV-7K2Q`), creates their Mercury
   card, and your phone gets **"AdVault: create account for <business>"**.
2. In **Google Ads**, signed in as 3pandalabs@gmail.com, create a **new
   account** (not under the manager). Name it **exactly** as the alert says —
   `AdVault — <business> [AV-7K2Q]` — currency **USD**, time zone
   **America/New_York**. When it pushes you to make a campaign, switch to
   Expert mode and choose to create the account without a campaign.
3. In that new account: **Billing → 3PandaLabs payments profile → add the
   card** named in the alert (full number from the Mercury app).
4. In the **manager account (641-518-4348)**: Accounts → **+** → **Link
   existing account** → enter the new account's ID. Then, inside the new
   account, accept the manager's request (Admin → Access and security →
   Managers).
5. Within 5 minutes the renderer finds the linked account by the `AV-` code in
   its name, attaches it to the customer, sees the card, and unlocks Launch.

If the account was created in the wrong currency, you get a "wrong currency"
alert: currency can't be changed, so make a new USD account with the same name
and unlink the wrong one. `counts.platformAwaitingAccount` on the admin page is
this step's to-do list.

Once linked accounts pass $1,000 of spend, Google allows creation, AdVault's
first attempt succeeds, and this whole section stops applying — no code change.

## The flow (once the manager can create accounts)

1. The customer presses **Set up my ad account** on a campaign's Launch card
   (or goes through `/dashboard/onboarding`).
2. AdVault creates a USD Google Ads account under the MCC named
   `AdVault — <business>`, and a **Mercury virtual debit card** named
   `AdVault – <business>` with a monthly limit of 31 days of their live budgets
   + 25% (minimum $50).
3. **Your phone gets an ntfy alert**: "AdVault: add card for <business>", with
   the Google Ads account id and the card's last four. Tapping it opens the
   account's billing page.
4. In the **Mercury app**, open that card and copy the full number. (Mercury's
   API never returns full card numbers.)
5. In **Google Ads**, on that account: **Billing → Setup → choose the existing
   3PandaLabs payments profile** (never create a second profile for the same
   business) → add the card.
6. The renderer checks Google every 5 minutes. Once billing shows as active, the
   customer's Launch button unlocks on its own. Reminders go out every 6 hours
   (up to 8) while a card is still missing.
7. When the customer launches, the campaign is created **ENABLED**: they have
   no Google access to switch it on, and the wallet guard has already required
   3 days of budget. The card limit is re-synced to their live budgets.

`counts.platformAwaitingCard` in `/metrics` (admin page) is the to-do list.

## Safety nets

- **Wallet guard**: launch needs 3 days of budget on hand.
- **Spend sync** pauses a customer's campaigns at Google when their wallet hits
  zero.
- **Card limit** at the bank caps a month's spend whatever happens in software.
- **Card freeze** is the backstop if pausing at Google fails. It is
  deliberately NOT used after a successful pause: Google still has to charge
  for ads already shown, and a declined charge flags the account. A top-up
  unfreezes the card.
- **Disconnecting** a platform account cancels its card (permanent).

## One-time setup

### Mercury
1. **Settings → API tokens**: create a **read-write** token. If Mercury asks for
   allowed IPs, add the server's `167.233.223.241`.
2. Pick the **checking account** cards spend from, and the **cardholder** (the
   team member every card belongs to). Their ids come from the API:
   `GET https://api.mercury.com/api/v1/accounts` and `GET .../users` with
   `Authorization: Bearer <token>`.

### ntfy
On the server, in `/data/monitoring`:

```sh
docker compose exec ntfy ntfy user add --role=user advault        # prompts for a password
docker compose exec ntfy ntfy access advault advault-ops write-only
docker compose exec ntfy ntfy token add advault                    # prints tk_...
docker compose exec ntfy ntfy access <your-phone-user> advault-ops read-only
```

Subscribe to `advault-ops` in the ntfy phone app (server `https://ntfy.3pandalabs.com`).

### Coolify: on BOTH advault-api and advault-renderer
```
ADVAULT_BILLING_MODES=platform
MERCURY_API_TOKEN=secret-token:...
MERCURY_ACCOUNT_ID=<checking account uuid>
MERCURY_CARDHOLDER_USER_ID=<user uuid>
OPS_NTFY_URL=https://ntfy.3pandalabs.com/advault-ops
OPS_NTFY_TOKEN=tk_...
```
The renderer runs the 5-minute billing sweep and the spend sync; the API
creates the account and card. Without the Mercury vars, everything still works
and the alert asks you to make the card by hand.

### Google
- **Advertiser verification**: Google will ask 3PandaLabs LLC, as the payer, to
  verify once. Do it early; unverified payers on brand-new accounts get more
  payment reviews.
- **Monthly invoicing**: apply once spend history allows. With it, payments
  accounts become listable from each child and AdVault attaches billing
  automatically — the card step and the alert disappear with no code change.

## Known limits

- **USD only.** The payments profile is 3PandaLabs' US one and Mercury cards
  are USD, so platform accounts are created in USD. A campaign in another
  currency is refused at launch (`currency_mismatch`) rather than spending the
  wrong amount. Managed billing for Indian customers needs an Indian entity and
  payments profile.
- **Customers can't pause from AdVault yet.** Spend is capped by the wallet and
  the card; a self-serve pause button is a follow-up.

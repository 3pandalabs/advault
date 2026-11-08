import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "../../db/index.js";
import { adAccounts, campaigns } from "../../db/schema.js";
import { defaultTimeZone, listMccClients, mccAccessToken } from "../googleAds/mcc.js";
import {
  attachPlatformBilling,
  billingSetupUrl,
  hasActiveBillingSetup,
  listPaymentsAccounts,
  managerCustomerId,
} from "../googleAds/billingLink.js";
import {
  cancelCard,
  cardNickname,
  createCard,
  freezeCard,
  isMercuryConfigured,
  setMonthlyLimit,
  unfreezeCard,
} from "../mercury/index.js";
import { notifyOps } from "../ops/notify.js";
import {
  findOperatorAccount,
  formatCustomerId,
  monthlyCardLimitCents,
  operatorAccountName,
  reminderDue,
} from "./policy.js";

// ---------------------------------------------------------------------------
// Platform billing: 3PandaLabs pays Google for a customer's ads.
//
// The customer never touches Google. AdVault creates their Google Ads account
// under the MCC, then needs a payment method on it — and Google has no API that
// adds one. So:
//
//   1. If the MCC ever gets monthly invoicing, a payments account becomes
//      listable from the child and is attached automatically. Done.
//   2. Otherwise (the normal case today): create a Mercury virtual debit card
//      for this customer, alert an operator's phone to add it in Google Ads,
//      and poll Google until a funded billing setup appears. Launch unlocks on
//      its own at that point.
//
// Everything here records failure rather than throwing: the account already
// exists by the time this runs, and a transient error must leave a retryable
// row, not an orphaned customer.
// ---------------------------------------------------------------------------

type AccountRow = typeof adAccounts.$inferSelect;

function dollars(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

function nameOf(account: AccountRow): string {
  return (
    account.descriptiveName ??
    (account.customerId ? `account ${formatCustomerId(account.customerId)}` : "a new customer")
  );
}

async function update(id: string, patch: Partial<AccountRow>): Promise<void> {
  await db.update(adAccounts).set(patch).where(eq(adAccounts.id, id));
}

/** Daily budgets of everything this user has live, plus an optional extra. */
async function liveDailyBudgets(userId: string, extraCents?: number): Promise<number[]> {
  const rows = await db
    .select({ cents: campaigns.dailyBudgetCents })
    .from(campaigns)
    .where(and(eq(campaigns.userId, userId), eq(campaigns.status, "live")));
  const budgets = rows.map((r) => r.cents);
  if (extraCents) budgets.push(extraCents);
  return budgets;
}

/**
 * Called right after a platform-billed account is provisioned. Returns the
 * billing state the account was left in.
 */
export async function startPlatformBilling(
  account: AccountRow,
  opts: { initialDailyBudgetCents?: number } = {},
): Promise<"active" | "pending"> {
  const managerId = account.managerCustomerId ?? managerCustomerId();

  // 1. Automatic, if a payments account is reachable from the child.
  if (managerId && account.customerId) {
    try {
      const accessToken = await mccAccessToken();
      const available = await listPaymentsAccounts({
        accessToken,
        customerId: account.customerId,
        loginCustomerId: managerId,
      });
      const match =
        available.find((p) => p.currencyCode === account.currencyCode) ?? available[0];
      if (match) {
        await attachPlatformBilling({
          accessToken,
          childCustomerId: account.customerId,
          paymentsAccountResourceName: match.resourceName,
          loginCustomerId: managerId,
        });
        await update(account.id, {
          billingLinkStatus: "active",
          billingPaymentsAccountId: match.paymentsAccountId,
          billingConfirmedAt: new Date(),
        });
        return "active";
      }
    } catch (err) {
      // Not fatal: fall through to the card path, which works regardless.
      console.warn(JSON.stringify({ msg: "automatic platform billing unavailable", error: String(err) }));
    }
  }

  // 2. A card for the operator to add.
  await update(account.id, { billingLinkStatus: "pending" });
  const fresh = await ensureCustomerCard(account, opts.initialDailyBudgetCents);
  await notifyCardNeeded(fresh ?? account, { reminder: false });
  return "pending";
}

/** Creates this account's Mercury card once. Returns the updated row. */
export async function ensureCustomerCard(
  account: AccountRow,
  initialDailyBudgetCents?: number,
): Promise<AccountRow | null> {
  if (account.mercuryCardId || !isMercuryConfigured()) return null;
  // Mercury debit cards are USD. Platform accounts are created in USD for the
  // same reason; anything else gets a hand-made card from the operator.
  if (account.currencyCode && account.currencyCode !== "USD") return null;

  try {
    const limit = monthlyCardLimitCents(
      await liveDailyBudgets(account.userId, initialDailyBudgetCents),
    );
    const card = await createCard({ nickname: cardNickname(nameOf(account)), monthlyLimitCents: limit });
    const [row] = await db
      .update(adAccounts)
      .set({
        mercuryCardId: card.id,
        mercuryCardLastFour: card.lastFour,
        mercuryCardStatus: card.status,
        mercuryCardLimitCents: limit,
      })
      .where(eq(adAccounts.id, account.id))
      .returning();
    return row ?? null;
  } catch (err) {
    console.error(JSON.stringify({ msg: "mercury card creation failed", accountId: account.id, error: String(err) }));
    return null;
  }
}

/**
 * Google wouldn't let the MCC create this customer's account, so an operator
 * makes it. Creates their card first so one alert covers the whole job.
 */
export async function startOperatorProvisioning(
  account: AccountRow,
  opts: { initialDailyBudgetCents?: number } = {},
): Promise<void> {
  const fresh = await ensureCustomerCard(account, opts.initialDailyBudgetCents);
  await notifyAccountNeeded(fresh ?? account, { reminder: false });
}

/** The operator's to-do when the account itself doesn't exist yet. */
export async function notifyAccountNeeded(
  account: AccountRow,
  opts: { reminder: boolean },
): Promise<void> {
  const name = nameOf(account);
  const ref = account.provisionRef ?? "";
  const suggested = account.mercuryCardLimitCents ?? monthlyCardLimitCents([]);
  const mcc = formatCustomerId(account.managerCustomerId ?? managerCustomerId() ?? "");

  const cardLine = account.mercuryCardId
    ? `2. Billing: pick the 3PandaLabs payments profile and add Mercury card "${cardNickname(name)}" ending ${account.mercuryCardLastFour} (limit ${dollars(suggested)}/month; full number in the Mercury app).`
    : `2. Billing: create a Mercury virtual debit card "${cardNickname(name)}" (${dollars(suggested)}/month limit) on AdVault Ad Spend, then add it under the 3PandaLabs payments profile.`;

  const delivered = await notifyOps({
    title: `${opts.reminder ? "Reminder: " : ""}AdVault: create account for ${name}`,
    message: [
      `1. In Google Ads (3pandalabs@gmail.com) create a new account named exactly: ${operatorAccountName(name, ref)} | currency USD | time zone ${defaultTimeZone("USD")}. Skip campaign creation.`,
      cardLine,
      `3. In the manager account ${mcc}: Accounts > + > Link existing account > enter the new account's ID, then accept the request inside the new account.`,
      `AdVault finds it by the code ${ref} and unlocks Launch once billing is active.`,
    ].join("\n"),
    priority: opts.reminder ? 3 : 4,
    tags: ["new"],
    click: "https://ads.google.com/aw/accounts",
  });

  if (delivered) {
    await update(account.id, {
      opsNotifiedAt: new Date(),
      ...(opts.reminder ? { opsReminderCount: account.opsReminderCount + 1 } : {}),
    });
  }
}

/** The operator's to-do, as a phone notification. */
export async function notifyCardNeeded(
  account: AccountRow,
  opts: { reminder: boolean },
): Promise<void> {
  if (!account.customerId) return notifyAccountNeeded(account, opts);
  const name = nameOf(account);
  const cid = formatCustomerId(account.customerId);
  const suggested = account.mercuryCardLimitCents ?? monthlyCardLimitCents([]);

  const cardLine = account.mercuryCardId
    ? `Card: Mercury "${cardNickname(name)}" ending ${account.mercuryCardLastFour} (limit ${dollars(suggested)}/month). Copy the full number from the Mercury app.`
    : `No Mercury card was created automatically. Create a virtual debit card named "${cardNickname(name)}" with a ${dollars(suggested)} monthly limit.`;

  const delivered = await notifyOps({
    title: `${opts.reminder ? "Reminder: " : ""}AdVault: add card for ${name}`,
    message: [
      `Google Ads account ${cid} needs a payment method before ${name} can launch.`,
      cardLine,
      "In Google Ads: Billing > choose the 3PandaLabs payments profile > add the card.",
      "AdVault unlocks Launch automatically once Google shows billing as active.",
    ].join("\n"),
    priority: opts.reminder ? 3 : 4,
    tags: ["credit_card"],
    click: billingSetupUrl(account.customerId),
  });

  if (delivered) {
    await update(account.id, {
      opsNotifiedAt: new Date(),
      ...(opts.reminder ? { opsReminderCount: account.opsReminderCount + 1 } : {}),
    });
  }
}

/** Asks Google whether the operator has added the card yet. */
export async function refreshPlatformBilling(account: AccountRow): Promise<"active" | "pending"> {
  const managerId = account.managerCustomerId ?? managerCustomerId();
  if (!managerId || !account.customerId) return "pending";
  try {
    const funded = await hasActiveBillingSetup({
      accessToken: await mccAccessToken(),
      customerId: account.customerId,
      loginCustomerId: managerId,
    });
    await update(account.id, {
      billingCheckedAt: new Date(),
      ...(funded ? { billingLinkStatus: "active", billingConfirmedAt: new Date() } : {}),
    });
    return funded ? "active" : "pending";
  } catch (err) {
    // A failed poll must not change the state; record that we looked.
    await update(account.id, { billingCheckedAt: new Date() });
    console.warn(JSON.stringify({ msg: "platform billing poll failed", accountId: account.id, error: String(err) }));
    return "pending";
  }
}

/** Keeps the card's monthly limit in line with what this user has live. */
export async function syncCardLimit(userId: string, extraDailyCents?: number): Promise<void> {
  const [account] = await db
    .select()
    .from(adAccounts)
    .where(and(eq(adAccounts.userId, userId), eq(adAccounts.billingMode, "platform"), isNotNull(adAccounts.mercuryCardId)))
    .limit(1);
  if (!account?.mercuryCardId || !isMercuryConfigured()) return;

  const limit = monthlyCardLimitCents(await liveDailyBudgets(userId, extraDailyCents));
  if (limit === account.mercuryCardLimitCents) return;
  try {
    await setMonthlyLimit(account.mercuryCardId, limit);
    await update(account.id, { mercuryCardLimitCents: limit });
  } catch (err) {
    console.error(JSON.stringify({ msg: "mercury limit update failed", accountId: account.id, error: String(err) }));
  }
}

async function cardAccountsFor(userId: string): Promise<AccountRow[]> {
  return db
    .select()
    .from(adAccounts)
    .where(and(eq(adAccounts.userId, userId), isNotNull(adAccounts.mercuryCardId)));
}

/**
 * Freezes a user's card. Used as a BACKSTOP when pausing their campaigns at
 * Google failed, so spend would otherwise continue on our money. Not used after
 * a successful pause: Google still has to charge for ads already shown, and a
 * declined charge gets the account flagged.
 */
export async function freezeCardsForUser(userId: string, reason: string): Promise<void> {
  for (const account of await cardAccountsFor(userId)) {
    if (account.mercuryCardStatus !== "active") continue;
    try {
      await freezeCard(account.mercuryCardId!);
      await update(account.id, { mercuryCardStatus: "frozen" });
      await notifyOps({
        title: `AdVault: froze card for ${nameOf(account)}`,
        message: `Mercury card ending ${account.mercuryCardLastFour} was frozen: ${reason}`,
        priority: 4,
        tags: ["warning"],
      });
    } catch (err) {
      await notifyOps({
        title: `AdVault: FAILED to freeze card for ${nameOf(account)}`,
        message: `${reason}\nFreeze the Mercury card ending ${account.mercuryCardLastFour} by hand. Error: ${String(err).slice(0, 200)}`,
        priority: 5,
        tags: ["rotating_light"],
      });
    }
  }
}

/** Undoes a freeze once the customer has money in their wallet again. */
export async function unfreezeCardsForUser(userId: string): Promise<void> {
  for (const account of await cardAccountsFor(userId)) {
    if (account.mercuryCardStatus !== "frozen") continue;
    try {
      await unfreezeCard(account.mercuryCardId!);
      await update(account.id, { mercuryCardStatus: "active" });
    } catch (err) {
      console.error(JSON.stringify({ msg: "mercury unfreeze failed", accountId: account.id, error: String(err) }));
    }
  }
}

/** On disconnect: the card is useless without the account. Permanent. */
export async function cancelCardForAccount(account: AccountRow): Promise<void> {
  if (!account.mercuryCardId || account.mercuryCardStatus === "cancelled") return;
  try {
    await cancelCard(account.mercuryCardId);
    await update(account.id, { mercuryCardStatus: "cancelled" });
  } catch (err) {
    await notifyOps({
      title: `AdVault: cancel card for ${nameOf(account)} by hand`,
      message: `The account was removed but cancelling Mercury card ending ${account.mercuryCardLastFour} failed: ${String(err).slice(0, 200)}`,
      priority: 4,
      tags: ["warning"],
    });
  }
}

/**
 * The background half: polls every platform account still waiting for its
 * card, unlocks the ones that are done, and re-alerts for the rest. Runs in
 * the renderer, so it works when nobody has the dashboard open.
 */
export async function runPlatformBillingSweep(now = new Date()): Promise<{ activated: number; reminded: number }> {
  const waiting = await db
    .select()
    .from(adAccounts)
    .where(
      and(
        eq(adAccounts.isManaged, true),
        eq(adAccounts.billingMode, "platform"),
        inArray(adAccounts.billingLinkStatus, ["pending"]),
        eq(adAccounts.status, "active"),
      ),
    );

  // Operator-made accounts: one MCC listing per sweep covers all of them.
  const unmatched = waiting.filter((a) => !a.customerId && a.provisionRef);
  if (unmatched.length > 0) {
    try {
      const clients = await listMccClients();
      const taken = new Set(
        (await db.select({ id: adAccounts.customerId }).from(adAccounts).where(isNotNull(adAccounts.customerId)))
          .map((r) => r.id!),
      );
      for (const account of unmatched) {
        const found = findOperatorAccount(account.provisionRef!, clients, taken);
        if (!found) continue;
        if (found.currencyCode && found.currencyCode !== "USD") {
          // Currency is immutable at Google, so this account can never be
          // used. Say so once per wrong account, not every five minutes.
          const marker = `wrong_currency:${found.id}`;
          if (account.provisionError !== marker) {
            await update(account.id, { provisionError: marker });
            await notifyOps({
              title: `AdVault: wrong currency for ${nameOf(account)}`,
              message: `Account ${formatCustomerId(found.id)} (${account.provisionRef}) is in ${found.currencyCode}. Platform accounts must be USD. Create a new USD account with the same name and unlink this one.`,
              priority: 4,
              tags: ["warning"],
            });
          }
          continue;
        }
        taken.add(found.id);
        const [matched] = await db
          .update(adAccounts)
          .set({
            customerId: found.id,
            currencyCode: found.currencyCode ?? "USD",
            provisionStatus: "active",
            provisionError: null,
            provisionedAt: new Date(),
          })
          .where(eq(adAccounts.id, account.id))
          .returning();
        if (matched) Object.assign(account, matched);
        console.log(JSON.stringify({ msg: "matched operator-created account", accountId: account.id, ref: account.provisionRef }));
      }
    } catch (err) {
      console.warn(JSON.stringify({ msg: "MCC client listing failed", error: String(err) }));
    }
  }

  let activated = 0;
  let reminded = 0;
  for (const account of waiting) {
    if ((await refreshPlatformBilling(account)) === "active") {
      activated += 1;
      continue;
    }
    const due = reminderDue(account, now);
    if (due === "first") await notifyCardNeeded(account, { reminder: false });
    if (due === "reminder") {
      await notifyCardNeeded(account, { reminder: true });
      reminded += 1;
    }
  }
  return { activated, reminded };
}

/** Starts the sweep. Called from the renderer's main(). */
export function startPlatformBillingSweep(intervalMs = 5 * 60 * 1000): void {
  const tick = () =>
    runPlatformBillingSweep()
      .then((r) => {
        if (r.activated || r.reminded) console.log(JSON.stringify({ msg: "platform billing sweep", ...r }));
      })
      .catch((err) => console.error(JSON.stringify({ msg: "platform billing sweep threw", error: String(err) })));
  void tick();
  setInterval(tick, intervalMs).unref();
}

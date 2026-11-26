import { freezeCardsForUser } from "../lib/billing/managedCard.js";
import { and, eq, gte, isNotNull, like, or } from "drizzle-orm";
import { db } from "../db/index.js";
import { adAccounts, campaigns, ledgerEntries, wallets } from "../db/schema.js";
import { ledgerByDay, SPEND_REF_PREFIX, spendCorrection } from "../lib/wallet/spendDelta.js";
import {
  fetchCampaignSpend,
  isMccConfigured,
  mccAccessToken,
  microsToMinor,
  pauseCampaign,
} from "../lib/googleAds/mcc.js";
import { applyEntry, DuplicateLedgerEntry, getBalance } from "../lib/wallet/index.js";
import { resumeAllFundedCampaigns } from "../lib/billing/resume.js";
import { notifyOps } from "../lib/ops/notify.js";
import { notifyLowBudget } from "../lib/customerEmails/index.js";
import { daysOfBudget, isLowBalance, lowBalanceEpisode } from "../lib/wallet/runway.js";
import type { Currency } from "../lib/pricing/index.js";
import { pauseForFunds } from "../lib/schedule/spread.js";

// Reconciles Google's reported spend into the wallet, and pauses campaigns that
// have run their balance out.
//
// This is the other half of the launch guard. The guard stops an underfunded
// campaign from starting; this stops a funded one from running past its money.
// Without it the prepaid model is decorative — Google keeps serving until it is
// told to stop, and nobody tells it.
//
// Runs inside the renderer container (which is already a long-lived process, so
// it needs no new deployment) rather than the API, where it would fire once per
// replica.

/** Days of Google spend re-read each run; also how long a stopped campaign stays in the sync. */
const LOOKBACK_DAYS = 7;

const SYNC_INTERVAL_MS = Number(process.env.SPEND_SYNC_INTERVAL_MS ?? 60 * 60 * 1000);

function log(msg: string, extra?: unknown): void {
  console.log(JSON.stringify({ job: "spend-sync", msg, extra: extra ?? undefined }));
}

/** YYYY-MM-DD, N days back. Google segments by date in the account's timezone. */
function isoDaysAgo(days: number): string {
  const d = new Date(Date.now() - days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

export async function runSpendSync(): Promise<{ synced: number; paused: number; resumed?: number }> {
  if (!isMccConfigured()) {
    log("MCC not configured — nothing to sync");
    return { synced: 0, paused: 0 };
  }

  // Backstop for the top-up webhook's resume (lib/billing/resume.ts): a
  // campaign we paused for funds restarts once the balance covers it again.
  const resumed = await resumeAllFundedCampaigns().catch((err) => {
    log("resume sweep threw", String(err));
    return 0;
  });

  // Only PLATFORM-FUNDED, live campaigns — the ones whose spend actually left
  // our payments account and therefore has to be recovered from the wallet.
  //
  // Keyed on billing_mode, not is_managed. A managed child the customer pays
  // for looks identical structurally but is none of the wallet's business:
  // debiting it would charge an advertiser for spend they already paid Google
  // directly, and auto-pause would then stop a campaign we never funded.
  //
  // Live campaigns, PLUS any launched campaign that changed in the lookback
  // window (paused by the owner, paused for funds, taken down). Google reports
  // cost hours late, so the spend of a campaign's last serving hours usually
  // arrives after it stopped. Reading only `live` rows skipped that spend for
  // good and left the wallet too high (the first test ad: $1.70 spent, $0
  // debited, 2026-11-21). Only live rows are ever paused below.
  const recentlyStopped = new Date(Date.now() - (LOOKBACK_DAYS + 1) * 86_400_000);
  const rows = await db
    .select({ campaign: campaigns, account: adAccounts })
    .from(campaigns)
    .innerJoin(adAccounts, eq(campaigns.adAccountId, adAccounts.id))
    .where(
      and(
        or(eq(campaigns.status, "live"), gte(campaigns.updatedAt, recentlyStopped)),
        eq(adAccounts.billingMode, "platform"),
        isNotNull(campaigns.googleCampaignResourceName),
      ),
    );

  if (rows.length === 0) return { synced: 0, paused: 0, resumed };

  let accessToken: string;
  try {
    accessToken = await mccAccessToken();
  } catch (err) {
    log("could not obtain an MCC access token", String(err));
    return { synced: 0, paused: 0, resumed };
  }

  let synced = 0;
  let paused = 0;

  // One wallet pays all of a customer's live campaigns.
  const liveDailyByUser = new Map<string, number>();
  for (const r of rows) {
    if (r.campaign.status !== "live") continue;
    liveDailyByUser.set(r.campaign.userId, (liveDailyByUser.get(r.campaign.userId) ?? 0) + r.campaign.dailyBudgetCents);
  }

  // Grouped by customer so one Google query covers all of an advertiser's
  // campaigns rather than one query each.
  const byCustomer = new Map<string, typeof rows>();
  for (const row of rows) {
    const id = row.account.customerId;
    if (!id) continue;
    byCustomer.set(id, [...(byCustomer.get(id) ?? []), row]);
  }

  for (const [customerId, group] of byCustomer) {
    // Seven days of lookback rather than "since we last ran". Google restates
    // recent spend as invalid traffic is filtered out, so a figure read the
    // morning after can still change. Re-reading a week is cheap, and each
    // day only ever moves by the difference from what the ledger holds
    // (lib/wallet/spendDelta).
    let spendRows;
    try {
      spendRows = await fetchCampaignSpend({ accessToken, customerId, sinceDate: isoDaysAgo(LOOKBACK_DAYS) });
    } catch (err) {
      log("spend query failed for a customer", { customerId, error: String(err) });
      continue;
    }

    for (const row of group) {
      const mine = spendRows.filter(
        (s) => s.campaignResourceName === row.campaign.googleCampaignResourceName,
      );

      // What the ledger already holds per day for this campaign: each run
      // records only the difference from Google's latest figure (spendDelta).
      // Before 2026-11-25 a day was recorded once, at its first partial figure.
      const held = ledgerByDay(
        await db
          .select({ externalRef: ledgerEntries.externalRef, amountMinor: ledgerEntries.amountMinor })
          .from(ledgerEntries)
          .innerJoin(wallets, eq(wallets.id, ledgerEntries.walletId))
          .where(
            and(
              eq(wallets.userId, row.campaign.userId),
              like(ledgerEntries.externalRef, `${SPEND_REF_PREFIX}${row.campaign.id}:%`),
            ),
          ),
        row.campaign.id,
      );

      for (const day of mine) {
        const fix = spendCorrection({
          campaignId: row.campaign.id,
          date: day.date,
          reportedMinor: microsToMinor(day.costMicros),
          ledger: held.get(day.date),
        });
        if (!fix) continue;

        try {
          await applyEntry({
            userId: row.campaign.userId,
            currency: row.campaign.currencyCode as Currency,
            type: fix.type,
            amountMinor: fix.amountMinor,
            description:
              fix.type === "spend" ? `Google Ads spend ${day.date}` : `Google Ads spend ${day.date} lowered by Google`,
            campaignId: row.campaign.id,
            // Unique per correction; a racing run computes the same key and
            // lands as DuplicateLedgerEntry below.
            externalRef: fix.externalRef,
            // Google has already spent this money; refusing to record it would
            // not un-spend it. The wallet clamps at zero and the shortfall stays
            // visible in the ledger — see wallet.reconcile().
            allowOverdraft: true,
          });
          synced += 1;
        } catch (err) {
          if (err instanceof DuplicateLedgerEntry) continue;
          log("failed to record spend", { campaignId: row.campaign.id, error: String(err) });
        }
      }

      // Out of money → pause at Google. This is the moment the org stops
      // financing the campaign.
      // A SCHEDULED campaign (the spread days, "$55 a month") also stops while
      // money is left but under 2 days of budget: Google may spend 2x on its
      // next serving day, before this hourly sync sees it (lib/schedule/spread.ts).
      // A stopped campaign only needed its late spend recorded.
      if (row.campaign.status !== "live") continue;
      const balance = await getBalance(row.campaign.userId);
      if (
        pauseForFunds({
          balanceMinor: balance?.balanceMinor ?? 0,
          scheduled: row.campaign.adSchedule != null,
          liveDailyMinor: liveDailyByUser.get(row.campaign.userId) ?? row.campaign.dailyBudgetCents,
        })
      ) {
        try {
          await pauseCampaign({
            accessToken,
            customerId,
            campaignResourceName: row.campaign.googleCampaignResourceName!,
          });
          await db
            .update(campaigns)
            .set({ status: "paused", pausedForFundsAt: new Date(), updatedAt: new Date() })
            .where(eq(campaigns.id, row.campaign.id));
          paused += 1;
          log("paused a campaign for insufficient funds", { campaignId: row.campaign.id });
        } catch (err) {
          // Worth shouting about: a failed pause means the org keeps paying.
          log("FAILED TO PAUSE an out-of-funds campaign", {
            campaignId: row.campaign.id,
            error: String(err),
          });
          // The backstop: freeze their Mercury card so Google's next charge
          // declines. Only here, not after a successful pause — Google still
          // bills for ads already shown, and a declined charge flags the
          // account.
          await freezeCardsForUser(
            row.campaign.userId,
            `wallet empty and pausing campaign ${row.campaign.id} at Google failed`,
          ).catch((e) => log("card freeze threw", { error: String(e) }));
        }
      }
    }
  }

  await lowBalanceAlerts(rows.filter((r) => r.campaign.status === "live").map((r) => r.campaign.id));

  return { synced, paused, resumed };
}

/**
 * One operator line per low-balance episode (migration 0034). The customer
 * sees the banner on the dashboard and campaign page (computed live from the
 * balance by GET /wallet); this tells us, and since 2026-11-26 the customer
 * also gets ONE email per episode (same mark, lib/customerEmails).
 */
async function lowBalanceAlerts(campaignIds: string[]): Promise<void> {
  if (campaignIds.length === 0) return;
  // Re-read: some of these were just paused for funds.
  const live = await db
    .select({ campaign: campaigns })
    .from(campaigns)
    .innerJoin(adAccounts, eq(campaigns.adAccountId, adAccounts.id))
    .where(and(eq(campaigns.status, "live"), eq(adAccounts.billingMode, "platform")));
  const byUser = new Map<string, (typeof campaigns.$inferSelect)[]>();
  for (const { campaign } of live) byUser.set(campaign.userId, [...(byUser.get(campaign.userId) ?? []), campaign]);

  for (const [userId, list] of byUser) {
    try {
      const wallet = await getBalance(userId);
      const balance = wallet?.balanceMinor ?? 0;
      const currency = (wallet?.currencyCode ?? list[0]!.currencyCode) as Currency;
      const daily = list.reduce((sum, c) => sum + c.dailyBudgetCents, 0);
      const low = isLowBalance(balance, daily, currency);
      const toAlert = list.filter((c) => lowBalanceEpisode({ low, alertedAt: c.lowBalanceAlertedAt }) === "alert");
      const toClear = list.filter((c) => lowBalanceEpisode({ low, alertedAt: c.lowBalanceAlertedAt }) === "clear");
      for (const c of toClear) {
        await db.update(campaigns).set({ lowBalanceAlertedAt: null }).where(eq(campaigns.id, c.id));
      }
      if (toAlert.length === 0) continue;
      for (const c of toAlert) {
        await db.update(campaigns).set({ lowBalanceAlertedAt: new Date() }).where(eq(campaigns.id, c.id));
      }
      await notifyOps({
        title: `AdVault budget low: ${toAlert.map((c) => c.businessName).join(", ")}`,
        message: `Ad budget ${(balance / 100).toFixed(2)} ${currency} left, about ${daysOfBudget(balance, daily)} day(s) at ${(daily / 100).toFixed(2)}/day. The customer sees a top-up banner.`,
        priority: 2,
        tags: ["moneybag"],
      });
      notifyLowBudget(
        {
          userId,
          balanceMinor: balance,
          dailyMinor: daily,
          currency,
          daysLeft: daysOfBudget(balance, daily),
          campaigns: list.map((c) => ({ id: c.id, name: c.name })),
        },
        (m) => log(m),
      );
    } catch (err) {
      log("low-balance check failed", { userId, error: String(err) });
    }
  }
}

/** Starts the periodic sync. Called from the renderer's main(). */
export function startSpendSync(): void {
  const tick = () =>
    runSpendSync()
      .then((r) => {
        if (r.synced || r.paused || r.resumed) log("sync complete", r);
      })
      .catch((err) => log("sync threw", String(err)));

  void tick();
  // unref so the job never holds the container open on shutdown.
  setInterval(tick, SYNC_INTERVAL_MS).unref();
}

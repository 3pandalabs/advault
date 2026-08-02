import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { adAccounts, campaigns } from "../db/schema.js";
import {
  fetchCampaignSpend,
  isMccConfigured,
  mccAccessToken,
  microsToMinor,
  pauseCampaign,
} from "../lib/googleAds/mcc.js";
import { applyEntry, DuplicateLedgerEntry, getBalance } from "../lib/wallet/index.js";
import type { Currency } from "../lib/pricing/index.js";

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

const SYNC_INTERVAL_MS = Number(process.env.SPEND_SYNC_INTERVAL_MS ?? 60 * 60 * 1000);

function log(msg: string, extra?: unknown): void {
  console.log(JSON.stringify({ job: "spend-sync", msg, extra: extra ?? undefined }));
}

/** YYYY-MM-DD, N days back. Google segments by date in the account's timezone. */
function isoDaysAgo(days: number): string {
  const d = new Date(Date.now() - days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

export async function runSpendSync(): Promise<{ synced: number; paused: number }> {
  if (!isMccConfigured()) {
    log("MCC not configured — nothing to sync");
    return { synced: 0, paused: 0 };
  }

  // Only managed, live campaigns. An unmanaged campaign bills the advertiser's
  // own card and is none of the wallet's business.
  const rows = await db
    .select({ campaign: campaigns, account: adAccounts })
    .from(campaigns)
    .innerJoin(adAccounts, eq(campaigns.adAccountId, adAccounts.id))
    .where(
      and(
        eq(campaigns.status, "live"),
        eq(adAccounts.isManaged, true),
        isNotNull(campaigns.googleCampaignResourceName),
      ),
    );

  if (rows.length === 0) return { synced: 0, paused: 0 };

  let accessToken: string;
  try {
    accessToken = await mccAccessToken();
  } catch (err) {
    log("could not obtain an MCC access token", String(err));
    return { synced: 0, paused: 0 };
  }

  let synced = 0;
  let paused = 0;

  // Grouped by customer so one Google query covers all of an advertiser's
  // campaigns rather than one query each.
  const byCustomer = new Map<string, typeof rows>();
  for (const row of rows) {
    const id = row.account.customerId;
    byCustomer.set(id, [...(byCustomer.get(id) ?? []), row]);
  }

  for (const [customerId, group] of byCustomer) {
    // Seven days of lookback rather than "since we last ran". Google restates
    // recent spend as invalid traffic is filtered out, so a figure read the
    // morning after can still change. Re-reading a week is cheap and the
    // per-(campaign, date) idempotency key makes it safe — already-applied days
    // land as DuplicateLedgerEntry and are skipped.
    let spendRows;
    try {
      spendRows = await fetchCampaignSpend({ accessToken, customerId, sinceDate: isoDaysAgo(7) });
    } catch (err) {
      log("spend query failed for a customer", { customerId, error: String(err) });
      continue;
    }

    for (const row of group) {
      const mine = spendRows.filter(
        (s) => s.campaignResourceName === row.campaign.googleCampaignResourceName,
      );

      for (const day of mine) {
        const minor = microsToMinor(day.costMicros);
        if (minor <= 0) continue;

        try {
          await applyEntry({
            userId: row.campaign.userId,
            currency: row.campaign.currencyCode as Currency,
            type: "spend",
            amountMinor: -minor,
            description: `Google Ads spend ${day.date}`,
            campaignId: row.campaign.id,
            // The idempotency key. Stable per campaign-day, which is what makes
            // the seven-day lookback safe to re-run every hour.
            externalRef: `gads:${row.campaign.id}:${day.date}`,
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
      const balance = await getBalance(row.campaign.userId);
      if ((balance?.balanceMinor ?? 0) <= 0) {
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
        }
      }
    }
  }

  return { synced, paused };
}

/** Starts the periodic sync. Called from the renderer's main(). */
export function startSpendSync(): void {
  const tick = () =>
    runSpendSync()
      .then((r) => {
        if (r.synced || r.paused) log("sync complete", r);
      })
      .catch((err) => log("sync threw", String(err)));

  void tick();
  // unref so the job never holds the container open on shutdown.
  setInterval(tick, SYNC_INTERVAL_MS).unref();
}

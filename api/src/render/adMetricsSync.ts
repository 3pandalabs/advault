import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { adAccounts, campaigns } from "../db/schema.js";
import { decryptToken } from "../lib/crypto.js";
import { isGoogleAdsConfigured } from "../lib/googleAds/env.js";
import { isMccConfigured, mccAccessToken } from "../lib/googleAds/mcc.js";
import { refreshAccessToken } from "../lib/googleAds/oauth.js";
import {
  fetchAdPolicy,
  fetchDailyMetrics,
  fetchSegmentMetrics,
  hasSegmentMetrics,
  replaceSegmentMetrics,
  storeAdPolicy,
  upsertDailyMetrics,
} from "../lib/adMetrics/index.js";
import { isoDaysAgo } from "../lib/adMetrics/policy.js";

// Pulls ad performance (impressions, views, clicks, cost) for every launched
// campaign into campaign_daily_metrics, for the dashboard's Performance card
// and GET /admin/metrics.
//
// READ-ONLY at Google: one googleAds:search per ad account per pass, never a
// mutate. Sibling of spendSync rather than part of it because spendSync is
// deliberately scoped to PLATFORM-billed campaigns (it moves wallet money);
// analytics wants every launched campaign, whoever pays.
//
// Runs in the renderer next to spendSync and outside RENDER_CONCURRENCY — it
// is network-bound and must never hold the box's only ffmpeg slot.

const SYNC_INTERVAL_MS = Number(process.env.AD_METRICS_SYNC_INTERVAL_MS ?? 60 * 60 * 1000);
// Google restates recent days as invalid traffic is filtered out, so the
// window is re-read whole on every pass and the rows overwritten.
const LOOKBACK_DAYS = Number(process.env.AD_METRICS_LOOKBACK_DAYS ?? 7);
// A campaign with no breakdown rows yet (launched before migration 0035, or
// new) is backfilled from its launch date, capped here.
const SEGMENT_BACKFILL_MAX_DAYS = 90;
// Breakdowns cost 7-8 searches per account, so they refresh every 3 hours,
// not every hourly pass (Basic access counts every search against a daily
// operations cap). The results screen says data is about 3 hours behind.
const SEGMENT_INTERVAL_MS = Number(process.env.AD_SEGMENTS_SYNC_INTERVAL_MS ?? 3 * 60 * 60 * 1000);
let lastSegmentsAt = 0;

function log(msg: string, extra?: unknown): void {
  console.log(JSON.stringify({ job: "ad-metrics-sync", msg, extra: extra ?? undefined }));
}

export async function runAdMetricsSync(): Promise<{ accounts: number; rows: number }> {
  if (!isGoogleAdsConfigured()) return { accounts: 0, rows: 0 };

  // Live AND paused: a campaign paused yesterday still has a week of numbers
  // its owner wants to see, and Google may still restate them.
  const rows = await db
    .select({ campaign: campaigns, account: adAccounts })
    .from(campaigns)
    .innerJoin(adAccounts, eq(campaigns.adAccountId, adAccounts.id))
    .where(
      and(
        inArray(campaigns.status, ["live", "paused"]),
        isNotNull(campaigns.googleCampaignResourceName),
        eq(adAccounts.status, "active"),
      ),
    );
  if (rows.length === 0) return { accounts: 0, rows: 0 };

  // Grouped by account: the credential is per account, and one search covers
  // every campaign in it.
  const byAccount = new Map<string, typeof rows>();
  for (const row of rows) {
    byAccount.set(row.account.id, [...(byAccount.get(row.account.id) ?? []), row]);
  }

  const sinceDate = isoDaysAgo(LOOKBACK_DAYS);
  const untilDate = isoDaysAgo(-1); // tomorrow: accounts ahead of UTC
  let accounts = 0;
  let written = 0;
  const doSegments = Date.now() - lastSegmentsAt >= SEGMENT_INTERVAL_MS;
  if (doSegments) lastSegmentsAt = Date.now();

  for (const group of byAccount.values()) {
    const account = group[0].account;
    const customerId = group[0].campaign.googleCustomerId ?? account.customerId;
    if (!customerId) continue;

    let accessToken: string;
    try {
      // Same credential choice as routes/launch.ts: the MCC's own token for a
      // managed child, the advertiser's stored grant otherwise.
      if (account.isManaged) {
        if (!isMccConfigured()) continue;
        accessToken = await mccAccessToken();
      } else {
        if (!account.refreshTokenCiphertext) continue;
        accessToken = await refreshAccessToken(decryptToken(account.refreshTokenCiphertext));
      }
    } catch (err) {
      // Not marking the account revoked here — that is launch's job, where the
      // advertiser is present to reconnect. A report sweep just skips.
      log("could not obtain an access token", { adAccountId: account.id, error: String(err) });
      continue;
    }

    let daily;
    try {
      daily = await fetchDailyMetrics({
        accessToken,
        customerId,
        loginCustomerId: account.loginCustomerId,
        sinceDate,
        untilDate,
      });
    } catch (err) {
      log("metrics query failed", { adAccountId: account.id, customerId, error: String(err) });
      continue;
    }
    accounts += 1;

    for (const { campaign } of group) {
      const mine = daily.filter((d) => d.campaignResourceName === campaign.googleCampaignResourceName);
      try {
        await upsertDailyMetrics(campaign.id, mine);
        written += mine.length;
      } catch (err) {
        log("failed to store metrics", { campaignId: campaign.id, error: String(err) });
      }
    }

    // Results-screen breakdowns (age, gender, device, network, hour, area):
    // one more read-only search per dimension. Own try, like the policy read.
    if (doSegments) try {
      let segSince = sinceDate;
      for (const { campaign } of group) {
        if (!campaign.launchedAt || (await hasSegmentMetrics(campaign.id))) continue;
        const launched = campaign.launchedAt.toISOString().slice(0, 10);
        const floor = isoDaysAgo(SEGMENT_BACKFILL_MAX_DAYS);
        const from = launched < floor ? floor : launched;
        if (from < segSince) segSince = from;
      }
      const segments = await fetchSegmentMetrics({
        accessToken,
        customerId,
        loginCustomerId: account.loginCustomerId,
        sinceDate: segSince,
        untilDate,
        onError: (dimension, err) =>
          log("segment query failed", { adAccountId: account.id, customerId, dimension, error: String(err) }),
      });
      for (const { campaign } of group) {
        for (const [dimension, rows] of segments) {
          const mine = rows.filter((r) => r.campaignResourceName === campaign.googleCampaignResourceName);
          await replaceSegmentMetrics(campaign.id, dimension, segSince, untilDate, mine);
        }
      }
    } catch (err) {
      log("segment sync failed", { adAccountId: account.id, customerId, error: String(err) });
    }

    // Google's own ad review (approved / under review / disapproved), one
    // more read-only search per account. Its own try: a failure here must
    // never cost the metrics written above.
    try {
      const policy = await fetchAdPolicy({ accessToken, customerId, loginCustomerId: account.loginCustomerId });
      for (const { campaign } of group) {
        const row = policy.find((p) => p.campaignResourceName === campaign.googleCampaignResourceName);
        if (row) await storeAdPolicy(campaign.id, row);
      }
    } catch (err) {
      log("ad policy query failed", { adAccountId: account.id, customerId, error: String(err) });
    }
  }

  return { accounts, rows: written };
}

/** Starts the periodic sync. Called from the renderer's main(). */
export function startAdMetricsSync(): void {
  const tick = () =>
    runAdMetricsSync()
      .then((r) => {
        if (r.accounts) log("sync complete", r);
      })
      .catch((err) => log("sync threw", String(err)));

  void tick();
  // unref so the job never holds the container open on shutdown.
  setInterval(tick, SYNC_INTERVAL_MS).unref();
}

import { and, asc, eq, gte } from "drizzle-orm";
import { db } from "../../db/index.js";
import { adAccounts, campaignDailyMetrics, campaignSegmentMetrics, wallets } from "../../db/schema.js";
import type { Currency } from "../pricing/index.js";
import { isoDaysAgo, microsToMinor } from "./policy.js";
import { rangeSince, type ResultsRange } from "./segments.js";
import { assembleResults } from "./resultsView.js";

// I/O half of GET /campaigns/:id/results. Reads the stored report copies only
// (campaign_daily_metrics + campaign_segment_metrics), never Google.

export async function loadResults(
  campaign: {
    id: string;
    userId: string;
    currencyCode: string;
    dailyBudgetCents: number;
    launchedAt: Date | null;
    adAccountId: string | null;
  },
  range: ResultsRange,
) {
  const currency = campaign.currencyCode as Currency;
  const since = rangeSince(range, campaign.launchedAt, (d) => isoDaysAgo(d));
  const recentSince = isoDaysAgo(6);
  const earliest = since < recentSince ? since : recentSince;

  const allDaily = await db
    .select()
    .from(campaignDailyMetrics)
    .where(and(eq(campaignDailyMetrics.campaignId, campaign.id), gte(campaignDailyMetrics.date, earliest)))
    .orderBy(asc(campaignDailyMetrics.date));
  const segments = await db
    .select()
    .from(campaignSegmentMetrics)
    .where(and(eq(campaignSegmentMetrics.campaignId, campaign.id), gte(campaignSegmentMetrics.date, since)));

  // The wallet only pays for platform-billed campaigns.
  let balanceMinor: number | null = null;
  if (campaign.adAccountId) {
    const [acct] = await db
      .select({ billingMode: adAccounts.billingMode })
      .from(adAccounts)
      .where(eq(adAccounts.id, campaign.adAccountId))
      .limit(1);
    if (acct?.billingMode === "platform") {
      const [w] = await db
        .select({ balanceMinor: wallets.balanceMinor })
        .from(wallets)
        .where(eq(wallets.userId, campaign.userId))
        .limit(1);
      balanceMinor = w?.balanceMinor ?? 0;
    }
  }

  return assembleResults({
    range,
    since,
    currency,
    daily: allDaily.filter((d) => d.date >= since),
    segments,
    balanceMinor,
    dailyBudgetMinor: campaign.dailyBudgetCents,
    recentDailySpendMinor: allDaily.filter((d) => d.date >= recentSince).map((d) => microsToMinor(d.costMicros)),
  });
}

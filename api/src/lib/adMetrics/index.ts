import { and, asc, eq, gte, isNotNull, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { campaignDailyMetrics, campaigns, users } from "../../db/schema.js";
import { googleAdsCall } from "../googleAds/client.js";
import type { Currency } from "../pricing/index.js";
import {
  AD_POLICY_QUERY,
  parseAdPolicyResults,
  type AdPolicyRow,
  type GaqlAdPolicyResult,
} from "./adPolicy.js";
import {
  buildDailyMetricsQuery,
  parseDailyMetricsResults,
  sumCounts,
  summarise,
  type DailyMetricsRow,
  type GaqlMetricsResult,
  type MetricCounts,
  type MetricSummary,
} from "./policy.js";

// I/O half of ad performance analytics. Google is only ever READ here
// (googleAds:search) — no mutate endpoint is reachable from this module.

/** Daily metrics for every campaign in one customer account. */
export async function fetchDailyMetrics(args: {
  accessToken: string;
  customerId: string;
  loginCustomerId?: string | null;
  sinceDate: string;
  untilDate: string;
}): Promise<DailyMetricsRow[]> {
  const body = await googleAdsCall<{ results?: GaqlMetricsResult[] }>(
    `/customers/${args.customerId}/googleAds:search`,
    args.accessToken,
    {
      method: "POST",
      loginCustomerId: args.loginCustomerId,
      body: { query: buildDailyMetricsQuery(args.sinceDate, args.untilDate) },
    },
  );
  return parseDailyMetricsResults(body.results);
}

/** Google's policy verdict on every ad in one customer account. Read-only. */
export async function fetchAdPolicy(args: {
  accessToken: string;
  customerId: string;
  loginCustomerId?: string | null;
}): Promise<AdPolicyRow[]> {
  const body = await googleAdsCall<{ results?: GaqlAdPolicyResult[] }>(
    `/customers/${args.customerId}/googleAds:search`,
    args.accessToken,
    { method: "POST", loginCustomerId: args.loginCustomerId, body: { query: AD_POLICY_QUERY } },
  );
  return parseAdPolicyResults(body.results);
}

export async function storeAdPolicy(campaignId: string, row: AdPolicyRow): Promise<void> {
  await db
    .update(campaigns)
    .set({
      googleAdApprovalStatus: row.approvalStatus,
      googleAdReviewStatus: row.reviewStatus,
      googleAdPolicyTopics: row.topics,
      googleAdPolicyCheckedAt: new Date(),
    })
    .where(eq(campaigns.id, campaignId));
}

/** Overwrites (campaign, date) rows — Google restates recent days, so the latest read wins. */
export async function upsertDailyMetrics(
  campaignId: string,
  rows: Pick<DailyMetricsRow, "date" | "impressions" | "views" | "clicks" | "costMicros">[],
): Promise<void> {
  if (rows.length === 0) return;
  const now = new Date();
  await db
    .insert(campaignDailyMetrics)
    .values(rows.map((r) => ({ campaignId, ...r, updatedAt: now })))
    .onConflictDoUpdate({
      target: [campaignDailyMetrics.campaignId, campaignDailyMetrics.date],
      set: {
        impressions: sql`excluded.impressions`,
        views: sql`excluded.views`,
        clicks: sql`excluded.clicks`,
        costMicros: sql`excluded.cost_micros`,
        updatedAt: now,
      },
    });
}

export type DailyMetricsView = MetricSummary & { date: string };

/** One campaign's daily rows and totals since `sinceDate`, for its owner. */
export async function campaignMetrics(campaignId: string, currency: Currency, sinceDate: string) {
  const rows = await db
    .select()
    .from(campaignDailyMetrics)
    .where(and(eq(campaignDailyMetrics.campaignId, campaignId), gte(campaignDailyMetrics.date, sinceDate)))
    .orderBy(asc(campaignDailyMetrics.date));

  const lastSyncedAt = rows.reduce<Date | null>(
    (latest, r) => (!latest || r.updatedAt > latest ? r.updatedAt : latest),
    null,
  );

  return {
    totals: summarise(sumCounts(rows), currency),
    daily: rows.map<DailyMetricsView>((r) => ({ date: r.date, ...summarise(r, currency) })),
    lastSyncedAt: lastSyncedAt?.toISOString() ?? null,
  };
}

/** Every launched campaign with its totals since `sinceDate`. Admin/ops only. */
export async function allCampaignMetrics(sinceDate: string) {
  // Aggregated in SQL: bigint sums come back as strings and are converted below.
  const sums = db
    .select({
      campaignId: campaignDailyMetrics.campaignId,
      impressions: sql<string>`sum(${campaignDailyMetrics.impressions})`.as("impressions"),
      views: sql<string>`sum(${campaignDailyMetrics.views})`.as("views"),
      clicks: sql<string>`sum(${campaignDailyMetrics.clicks})`.as("clicks"),
      costMicros: sql<string>`sum(${campaignDailyMetrics.costMicros})`.as("cost_micros"),
      lastSyncedAt: sql<Date>`max(${campaignDailyMetrics.updatedAt})`.as("last_synced_at"),
    })
    .from(campaignDailyMetrics)
    .where(gte(campaignDailyMetrics.date, sinceDate))
    .groupBy(campaignDailyMetrics.campaignId)
    .as("sums");

  const rows = await db
    .select({
      campaignId: campaigns.id,
      name: campaigns.name,
      businessName: campaigns.businessName,
      userEmail: users.email,
      status: campaigns.status,
      currency: campaigns.currencyCode,
      googleCustomerId: campaigns.googleCustomerId,
      launchedAt: campaigns.launchedAt,
      impressions: sums.impressions,
      views: sums.views,
      clicks: sums.clicks,
      costMicros: sums.costMicros,
      lastSyncedAt: sums.lastSyncedAt,
    })
    .from(campaigns)
    .innerJoin(users, eq(users.id, campaigns.userId))
    .leftJoin(sums, eq(sums.campaignId, campaigns.id))
    .where(isNotNull(campaigns.googleCampaignResourceName))
    .orderBy(asc(campaigns.launchedAt));

  const totalsByCurrency = new Map<Currency, MetricCounts[]>();
  const list = rows.map((r) => {
    const currency = r.currency as Currency;
    const counts: MetricCounts = {
      impressions: Number(r.impressions ?? 0),
      views: Number(r.views ?? 0),
      clicks: Number(r.clicks ?? 0),
      costMicros: Number(r.costMicros ?? 0),
    };
    totalsByCurrency.set(currency, [...(totalsByCurrency.get(currency) ?? []), counts]);
    return {
      campaignId: r.campaignId,
      name: r.name,
      businessName: r.businessName,
      userEmail: r.userEmail,
      status: r.status,
      currency,
      googleCustomerId: r.googleCustomerId,
      launchedAt: r.launchedAt?.toISOString() ?? null,
      lastSyncedAt: r.lastSyncedAt ? new Date(r.lastSyncedAt).toISOString() : null,
      totals: summarise(counts, currency),
    };
  });

  // Never summed across currencies — a rupee and a dollar are not the same unit.
  const totals = Object.fromEntries(
    [...totalsByCurrency].map(([currency, c]) => [currency, summarise(sumCounts(c), currency)]),
  );

  return { campaigns: list, totals };
}

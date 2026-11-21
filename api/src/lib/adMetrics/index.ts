import { and, asc, between, eq, gte, isNotNull, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { adAccounts, campaignDailyMetrics, campaignSegmentMetrics, campaigns, users } from "../../db/schema.js";
import {
  buildGeoNameQuery,
  buildSegmentQuery,
  geoConstantIds,
  geoLabels,
  parseSegmentResults,
  SEGMENT_DIMENSIONS,
  type GaqlGeoResult,
  type GaqlSegmentResult,
  type SegmentDimension,
  type SegmentRow,
} from "./segments.js";
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

/**
 * The dashboard list's stats row (2026-11-20, GET /campaigns/stats): totals
 * since launch for every one of ONE owner's launched campaigns, in one query
 * (no per-card round trip). `totals` is null until Google's first numbers
 * arrive. `walletPays` = the AdVault ad budget pays (platform billing), i.e.
 * the campaign page shows its "Your ad budget" top-up card.
 */
export async function ownerCampaignStats(userId: string) {
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
    .innerJoin(campaigns, eq(campaigns.id, campaignDailyMetrics.campaignId))
    .where(eq(campaigns.userId, userId))
    .groupBy(campaignDailyMetrics.campaignId)
    .as("sums");

  const rows = await db
    .select({
      campaignId: campaigns.id,
      currency: campaigns.currencyCode,
      billingMode: adAccounts.billingMode,
      impressions: sums.impressions,
      views: sums.views,
      clicks: sums.clicks,
      costMicros: sums.costMicros,
      lastSyncedAt: sums.lastSyncedAt,
    })
    .from(campaigns)
    .leftJoin(adAccounts, eq(adAccounts.id, campaigns.adAccountId))
    .leftJoin(sums, eq(sums.campaignId, campaigns.id))
    .where(and(eq(campaigns.userId, userId), isNotNull(campaigns.googleCampaignResourceName)));

  return rows.map((r) => ({
    campaignId: r.campaignId,
    currency: r.currency as Currency,
    walletPays: r.billingMode === "platform",
    lastSyncedAt: r.lastSyncedAt ? new Date(r.lastSyncedAt).toISOString() : null,
    totals:
      r.impressions === null
        ? null
        : summarise(
            {
              impressions: Number(r.impressions),
              views: Number(r.views ?? 0),
              clicks: Number(r.clicks ?? 0),
              costMicros: Number(r.costMicros ?? 0),
            },
            r.currency as Currency,
          ),
  }));
}

// ---------------------------------------------------------------------------
// Results-screen breakdowns (migration 0035). Read-only at Google.
// ---------------------------------------------------------------------------

/**
 * One read-only search per dimension. A dimension whose query fails is left
 * out of the result (its stored rows are then kept, not wiped); one failing
 * breakdown never costs the others.
 */
export async function fetchSegmentMetrics(args: {
  accessToken: string;
  customerId: string;
  loginCustomerId?: string | null;
  sinceDate: string;
  untilDate: string;
  onError?: (dimension: SegmentDimension, err: unknown) => void;
}): Promise<Map<SegmentDimension, (SegmentRow & { label: string | null })[]>> {
  const out = new Map<SegmentDimension, (SegmentRow & { label: string | null })[]>();
  const search = <T>(query: string) =>
    googleAdsCall<{ results?: T[] }>(`/customers/${args.customerId}/googleAds:search`, args.accessToken, {
      method: "POST",
      loginCustomerId: args.loginCustomerId,
      body: { query },
    });

  for (const dimension of SEGMENT_DIMENSIONS) {
    try {
      const body = await search<GaqlSegmentResult>(buildSegmentQuery(dimension, args.sinceDate, args.untilDate));
      out.set(
        dimension,
        parseSegmentResults(dimension, body.results).map((r) => ({ ...r, label: null })),
      );
    } catch (err) {
      args.onError?.(dimension, err);
    }
  }

  // Place names for postal / city rows, in one lookup (chunks of 100).
  const geoRows = [...(out.get("postal") ?? []), ...(out.get("city") ?? [])];
  const ids = geoConstantIds(geoRows);
  const names = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 100) {
    try {
      const body = await search<GaqlGeoResult>(buildGeoNameQuery(ids.slice(i, i + 100)));
      for (const [k, v] of geoLabels(body.results)) names.set(k, v);
    } catch {
      // Unnamed areas fall back to "Area <id>"; never fatal.
    }
  }
  for (const r of geoRows) r.label = names.get(r.segment) ?? null;
  return out;
}

/** Replaces one campaign's rows for one dimension inside the re-read window (Google restates days). */
export async function replaceSegmentMetrics(
  campaignId: string,
  dimension: SegmentDimension,
  sinceDate: string,
  untilDate: string,
  rows: (Pick<SegmentRow, "date" | "segment" | "impressions" | "views" | "clicks" | "costMicros"> & { label: string | null })[],
): Promise<void> {
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .delete(campaignSegmentMetrics)
      .where(
        and(
          eq(campaignSegmentMetrics.campaignId, campaignId),
          eq(campaignSegmentMetrics.dimension, dimension),
          between(campaignSegmentMetrics.date, sinceDate, untilDate),
        ),
      );
    if (rows.length === 0) return;
    await tx.insert(campaignSegmentMetrics).values(
      rows.map((r) => ({
        campaignId,
        dimension,
        date: r.date,
        segment: r.segment,
        label: r.label,
        impressions: r.impressions,
        views: r.views,
        clicks: r.clicks,
        costMicros: r.costMicros,
        updatedAt: now,
      })),
    );
  });
}

/** Has this campaign any breakdown rows yet? (First sync backfills from launch.) */
export async function hasSegmentMetrics(campaignId: string): Promise<boolean> {
  const [row] = await db
    .select({ one: sql<number>`1` })
    .from(campaignSegmentMetrics)
    .where(eq(campaignSegmentMetrics.campaignId, campaignId))
    .limit(1);
  return Boolean(row);
}

import type { FastifyInstance } from "fastify";
import { and, desc, eq, gte, lt, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import { campaigns, creatives, purchases } from "../db/schema.js";
import { requireAdminOrAnalyticsToken } from "../auth/adminAccess.js";
import { requireAuth } from "../auth/plugin.js";
import { allCampaignMetrics, campaignMetrics, ownerCampaignStats } from "../lib/adMetrics/index.js";
import { loadResults } from "../lib/adMetrics/results.js";
import { clampRangeDays, isoDaysAgo } from "../lib/adMetrics/policy.js";
import { loadOwnedCampaign } from "../lib/ownership.js";
import type { Currency } from "../lib/pricing/index.js";

// Ad performance analytics. Both routes read campaign_daily_metrics only —
// the renderer sweep (render/adMetricsSync.ts) is what talks to Google, so a
// dashboard poll never costs a Google API call and never waits on one.

const NOTE =
  "Google Ads reports lag by a few hours, and recent days can still be revised.";

const rangeQuery = z.object({ days: z.coerce.number().optional() });

export async function adMetricsRoutes(app: FastifyInstance) {
  // The dashboard list's stats row: every launched campaign of the caller's
  // own, totals since launch, one query. Never anyone else's campaigns.
  app.get("/campaigns/stats", { preHandler: requireAuth }, async (req) => {
    return { note: NOTE, campaigns: await ownerCampaignStats(req.userId!) };
  });

  app.get(
    "/campaigns/:campaignId/metrics",
    {
      preHandler: requireAuth,
      schema: { params: z.object({ campaignId: z.string().uuid() }), querystring: rangeQuery },
    },
    async (req, reply) => {
      const { campaignId } = req.params as { campaignId: string };
      const days = clampRangeDays((req.query as { days?: number }).days);
      const campaign = await loadOwnedCampaign(campaignId, req.userId!, reply);
      if (!campaign) return;

      const since = isoDaysAgo(days - 1);
      const launched = Boolean(campaign.googleCampaignResourceName);
      const currency = campaign.currencyCode as Currency;
      const data = launched
        ? await campaignMetrics(campaignId, currency, since)
        : { totals: null, daily: [], lastSyncedAt: null };

      return { campaignId, launched, days, since, currency, note: NOTE, ...data };
    },
  );

  // "How your ad is doing" (2026-11-19): headline numbers, trend and the
  // who / where / when breakdowns for one range. Stored report copies only.
  app.get(
    "/campaigns/:campaignId/results",
    {
      preHandler: requireAuth,
      schema: {
        params: z.object({ campaignId: z.string().uuid() }),
        querystring: z.object({ range: z.enum(["7d", "30d", "all"]).default("7d") }),
      },
    },
    async (req, reply) => {
      const { campaignId } = req.params as { campaignId: string };
      const { range } = req.query as { range: "7d" | "30d" | "all" };
      const campaign = await loadOwnedCampaign(campaignId, req.userId!, reply);
      if (!campaign) return;
      if (!campaign.googleCampaignResourceName) return { campaignId, launched: false, range };
      return { campaignId, launched: true, ...(await loadResults(campaign, range)) };
    },
  );

  app.get(
    "/admin/metrics",
    { preHandler: requireAdminOrAnalyticsToken, schema: { querystring: rangeQuery } },
    async (req) => {
      const days = clampRangeDays((req.query as { days?: number }).days);
      const since = isoDaysAgo(days - 1);
      return { days, since, note: NOTE, ...(await allCampaignMetrics(since)) };
    },
  );

  // The last renders and what each used (creatives.render_info): engine,
  // motion clips, voice. Ops diagnostics without container logs.
  app.get(
    "/admin/recent-renders",
    {
      preHandler: requireAdminOrAnalyticsToken,
      schema: { querystring: z.object({ limit: z.coerce.number().int().min(1).max(50).default(10) }) },
    },
    async (req) => {
      const { limit } = req.query as { limit: number };
      const rows = await db
        .select({
          creativeId: creatives.id,
          campaignId: creatives.campaignId,
          businessName: campaigns.businessName,
          businessCategory: campaigns.businessCategory,
          aspectRatio: creatives.aspectRatio,
          kind: creatives.kind,
          renderStatus: creatives.renderStatus,
          renderError: creatives.renderError,
          renderedAt: creatives.renderedAt,
          createdAt: creatives.createdAt,
          renderInfo: creatives.renderInfo,
          sticker: sql<unknown>`${creatives.script} -> 'sticker'`,
          peopleIndexes: sql<unknown>`${creatives.script} -> 'peopleIndexes'`,
          portraitIndex: sql<unknown>`${creatives.script} -> 'portraitIndex'`,
        })
        .from(creatives)
        .innerJoin(campaigns, eq(creatives.campaignId, campaigns.id))
        .orderBy(desc(creatives.createdAt))
        .limit(limit);
      return { renders: rows };
    },
  );

  // Ad production in a date range, for the org admin site's cost per ad
  // (Cash flow tab). Counts only, no customer data. `until` is exclusive.
  //   adsMade:   generations: distinct (campaign, minute) of AdVault-made
  //              creatives (both formats of one ad are made together)
  //   renders:   AdVault-made creatives (one per format, redos included)
  //   paidAds:   $10 new_ad orders paid in the range (amount > 0)
  app.get(
    "/admin/ad-production",
    {
      preHandler: requireAdminOrAnalyticsToken,
      schema: {
        querystring: z.object({
          since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        }),
      },
    },
    async (req) => {
      const { since, until } = req.query as { since: string; until: string };
      const from = new Date(`${since}T00:00:00Z`);
      const to = new Date(`${until}T00:00:00Z`);
      const [made] = await db
        .select({
          renders: sql<number>`count(*)::int`,
          adsMade: sql<number>`count(distinct (${creatives.campaignId}, date_trunc('minute', ${creatives.createdAt})))::int`,
        })
        .from(creatives)
        .where(and(ne(creatives.kind, "upload"), gte(creatives.createdAt, from), lt(creatives.createdAt, to)));
      const [paid] = await db
        .select({ paidAds: sql<number>`count(*)::int` })
        .from(purchases)
        .where(
          and(
            sql`${purchases.sku} = 'new_ad'`,
            sql`${purchases.amountMinor} > 0`,
            // Not admins' $0.50 "Test as customer" payments (lib/testMode),
            // test customers (0030), 3PandaLabs' own internal accounts (0032), or
            // accounts an admin marked as test (0046).
            sql`${purchases.userId} not in (select id from users where role = 'admin' or test_owner_id is not null or is_internal or marked_test)`,
            gte(purchases.paidAt, from),
            lt(purchases.paidAt, to),
          ),
        );
      // Internal accounts' full-price ads, reported on their own (not in paidAds).
      const [internal] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(purchases)
        .where(
          and(
            sql`${purchases.sku} = 'new_ad'`,
            sql`${purchases.amountMinor} > 0`,
            sql`${purchases.userId} in (select id from users where is_internal)`,
            gte(purchases.paidAt, from),
            lt(purchases.paidAt, to),
          ),
        );
      return {
        since,
        until,
        adsMade: made?.adsMade ?? 0,
        renders: made?.renders ?? 0,
        paidAds: paid?.paidAds ?? 0,
        internalPaidAds: internal?.n ?? 0,
      };
    },
  );
}

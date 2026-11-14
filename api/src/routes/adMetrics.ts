import type { FastifyInstance } from "fastify";
import { and, gte, lt, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import { creatives, purchases } from "../db/schema.js";
import { requireAdminOrAnalyticsToken } from "../auth/adminAccess.js";
import { requireAuth } from "../auth/plugin.js";
import { allCampaignMetrics, campaignMetrics } from "../lib/adMetrics/index.js";
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

  app.get(
    "/admin/metrics",
    { preHandler: requireAdminOrAnalyticsToken, schema: { querystring: rangeQuery } },
    async (req) => {
      const days = clampRangeDays((req.query as { days?: number }).days);
      const since = isoDaysAgo(days - 1);
      return { days, since, note: NOTE, ...(await allCampaignMetrics(since)) };
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
            gte(purchases.paidAt, from),
            lt(purchases.paidAt, to),
          ),
        );
      return { since, until, adsMade: made?.adsMade ?? 0, renders: made?.renders ?? 0, paidAds: paid?.paidAds ?? 0 };
    },
  );
}

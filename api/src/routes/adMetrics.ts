import type { FastifyInstance } from "fastify";
import { z } from "zod";
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
}

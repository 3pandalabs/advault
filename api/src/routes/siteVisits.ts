import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { recordSiteVisit } from "../lib/siteVisits/index.js";
import { createIpLimiter } from "../lib/siteVisits/policy.js";

// POST /track/visit (public, no session; 2026-11-21, migration 0045). The web
// app calls it once per browser session when a page on advault.3pandalabs.com
// loads with utm_campaign=<campaign id> (an ad click; lib/googleAds/utm).
// Always 204, whatever happened (unknown id, over a cap, garbage): it is a
// beacon, and the answer must not reveal which campaign ids exist. The IP is
// only an in-memory rate-limit key (lib/siteVisits/policy), never stored.

const body = z.object({
  campaignId: z.string().max(64),
  path: z.string().max(500).optional(),
});

export async function siteVisitRoutes(app: FastifyInstance) {
  const allow = createIpLimiter();
  app.post("/track/visit", { schema: { body } }, async (req, reply) => {
    const { campaignId, path } = req.body as z.infer<typeof body>;
    if (allow(req.ip)) {
      try {
        await recordSiteVisit(campaignId, path);
      } catch (err) {
        req.log.warn({ err }, "track_visit_failed");
      }
    }
    return reply.code(204).send();
  });
}

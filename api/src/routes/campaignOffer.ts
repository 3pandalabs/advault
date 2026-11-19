import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../auth/plugin.js";
import { db } from "../db/index.js";
import { campaigns } from "../db/schema.js";
import { loadOwnedCampaign } from "../lib/ownership.js";
import { claimBlock, claimFlags } from "../lib/categories/claims.js";
import { categoryKey } from "../lib/categories/key.js";

// The campaign's offer (the text the script writer turns into the ad) and its
// call to action, changeable in ANY status (2026-11-20). Used by the
// campaign page's season card (lib/categories/seasons.ts) and offer tools.
//
// It never touches Google and never re-renders: the live ad keeps the video
// and text it launched with, and the NEXT ad made uses the new offer. That is
// why this is its own route rather than PATCH /campaigns/:id, which refuses
// a live campaign (its budget and targeting would diverge from Google).

const params = z.object({ campaignId: z.string().uuid() });

export const offerInputSchema = z
  .object({
    offerDetails: z.string().trim().min(1).max(2000),
    callToAction: z.string().trim().min(1).max(40).optional(),
  })
  .strict();
type OfferInput = z.infer<typeof offerInputSchema>;

export async function campaignOfferRoutes(app: FastifyInstance) {
  app.addHook("onRequest", requireAuth);

  app.put("/campaigns/:campaignId/offer", { schema: { params, body: offerInputSchema } }, async (req, reply) => {
    const { campaignId } = req.params as { campaignId: string };
    const campaign = await loadOwnedCampaign(campaignId, req.userId!, reply);
    if (!campaign) return;
    const body = req.body as OfferInput;
    // Claim checks (lib/categories/claims): only what Google clearly forbids
    // is refused; the warnings come back for the page to show.
    const key = categoryKey(campaign.businessCategory);
    const blocked = claimBlock(key, body.offerDetails);
    if (blocked) return reply.code(400).send({ error: "claim_not_allowed", detail: blocked.reason, phrase: blocked.phrase });

    const [updated] = await db
      .update(campaigns)
      .set({
        offerDetails: body.offerDetails,
        ...(body.callToAction ? { callToAction: body.callToAction } : {}),
        updatedAt: new Date(),
      })
      .where(eq(campaigns.id, campaign.id))
      .returning();
    return {
      campaign: updated,
      liveAdUnchanged: Boolean(campaign.googleCampaignResourceName),
      warnings: claimFlags(key, body.offerDetails),
    };
  });
}

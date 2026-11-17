import { and, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../auth/plugin.js";
import { db } from "../db/index.js";
import { assets, campaigns } from "../db/schema.js";
import { loadOwnedCampaign } from "../lib/ownership.js";
import {
  BEFORE_AFTER_DETAIL,
  beforeAfterAllowed,
  beforeAfterInputSchema,
  beforeAfterViolation,
  pairAssetIds,
  type BeforeAfterInput,
  type BeforeAfterPair,
} from "../lib/beforeAfter/policy.js";

// "Show your work: before & after" (2026-11-17, lib/beforeAfter). The pairs
// live on the campaign, so the wizard, the campaign page and a paid order
// made later all read the same ones; the next ad made (and "Make me a
// website") uses them. Changing them never re-renders anything by itself.

const params = z.object({ campaignId: z.string().uuid() });

/** The campaign's pairs with each photo's R2 key (the web presigns thumbnails from it). */
async function pairsWithKeys(userId: string, pairs: BeforeAfterPair[] | null) {
  const ids = pairAssetIds(pairs);
  if (ids.length === 0) return [];
  const rows = await db
    .select({ id: assets.id, r2Key: assets.r2Key })
    .from(assets)
    .where(and(eq(assets.userId, userId), inArray(assets.id, ids)));
  const key = new Map(rows.map((r) => [r.id, r.r2Key]));
  // A deleted photo drops its pair (both halves or neither).
  return (pairs ?? []).flatMap((p) => {
    const beforeKey = key.get(p.beforeAssetId);
    const afterKey = key.get(p.afterAssetId);
    return beforeKey && afterKey ? [{ ...p, beforeKey, afterKey }] : [];
  });
}

export async function beforeAfterRoutes(app: FastifyInstance) {
  app.addHook("onRequest", requireAuth);

  app.get("/campaigns/:campaignId/before-after", { schema: { params } }, async (req, reply) => {
    const { campaignId } = req.params as { campaignId: string };
    const campaign = await loadOwnedCampaign(campaignId, req.userId!, reply);
    if (!campaign) return;
    return {
      allowed: beforeAfterAllowed(campaign.businessCategory),
      pairs: await pairsWithKeys(req.userId!, campaign.beforeAfter),
      attestedAt: campaign.beforeAfterAttestedAt,
    };
  });

  app.put(
    "/campaigns/:campaignId/before-after",
    { schema: { params, body: beforeAfterInputSchema } },
    async (req, reply) => {
      const { campaignId } = req.params as { campaignId: string };
      const campaign = await loadOwnedCampaign(campaignId, req.userId!, reply);
      if (!campaign) return;
      const body = req.body as BeforeAfterInput;

      const violation = beforeAfterViolation(campaign.businessCategory, body);
      if (violation) return reply.code(400).send({ error: violation, detail: BEFORE_AFTER_DETAIL[violation] });

      // Only the advertiser's own photos: without the userId filter, someone
      // could put another advertiser's photo in their ad as "our work".
      const ids = pairAssetIds(body.pairs);
      if (ids.length > 0) {
        const owned = await db
          .select({ id: assets.id })
          .from(assets)
          .where(and(eq(assets.userId, req.userId!), eq(assets.kind, "photo"), inArray(assets.id, ids)));
        if (owned.length !== ids.length) return reply.code(400).send({ error: "unknown_assets" });
      }

      const empty = body.pairs.length === 0;
      const [updated] = await db
        .update(campaigns)
        .set({
          beforeAfter: empty ? null : body.pairs,
          beforeAfterAttestedAt: empty ? null : new Date(),
          beforeAfterAttestedBy: empty ? null : req.userId!,
          updatedAt: new Date(),
        })
        .where(eq(campaigns.id, campaign.id))
        .returning();
      return {
        allowed: true,
        pairs: await pairsWithKeys(req.userId!, updated!.beforeAfter),
        attestedAt: updated!.beforeAfterAttestedAt,
      };
    },
  );
}

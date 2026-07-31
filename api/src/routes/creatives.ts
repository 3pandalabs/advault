import { and, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../auth/plugin.js";
import { db } from "../db/index.js";
import { assets, campaigns, creatives } from "../db/schema.js";
import { loadOwnedCampaign, loadOwnedCreative } from "../lib/ownership.js";
import { generateScript } from "../lib/script/generate.js";
import { adScriptSchema } from "../lib/script/schema.js";
import { enqueueRender } from "../render/jobs.js";
import { campaignIdForCreativeKey, presignDownload } from "../plugins/r2.js";

const ASPECT_RATIOS = ["16:9", "9:16"] as const;

export async function creativeRoutes(app: FastifyInstance) {
  app.addHook("onRequest", requireAuth);

  // Step three of the wizard: write the scripts and queue the renders.
  //
  // Returns immediately with queued creatives rather than waiting on ffmpeg —
  // an encode takes ~30s per creative on a shared box, and holding an HTTP
  // request open for a minute is how you discover every proxy timeout between
  // the browser and the container. The dashboard polls GET /campaigns/:id.
  app.post(
    "/campaigns/:campaignId/creatives/generate",
    {
      schema: {
        params: z.object({ campaignId: z.string().uuid() }),
        body: z.object({
          assetIds: z.array(z.string().uuid()).min(1).max(5),
          aspectRatios: z.array(z.enum(ASPECT_RATIOS)).min(1).max(2).default(["16:9", "9:16"]),
        }),
      },
    },
    async (req, reply) => {
      const { campaignId } = req.params as { campaignId: string };
      const body = req.body as { assetIds: string[]; aspectRatios: ("16:9" | "9:16")[] };

      const campaign = await loadOwnedCampaign(campaignId, req.userId!, reply);
      if (!campaign) return;
      if (campaign.status === "live") {
        return reply.code(409).send({ error: "campaign_is_live" });
      }

      // Filtered by userId as well as by id: without it, an advertiser could
      // pass another advertiser's asset ids and have their photos rendered
      // into an ad. The ownership check is the whole point of this query.
      const ownedAssets = await db
        .select()
        .from(assets)
        .where(and(eq(assets.userId, req.userId!), inArray(assets.id, body.assetIds)));

      if (ownedAssets.length !== body.assetIds.length) {
        return reply.code(400).send({ error: "unknown_assets" });
      }

      // Preserve the order the advertiser chose — it is the order the scenes
      // will play in, and the model's assetIndex values point into it.
      const orderedKeys = body.assetIds.map(
        (id) => ownedAssets.find((a) => a.id === id)!.r2Key,
      );

      const created = [];
      for (const aspectRatio of body.aspectRatios) {
        // Scripted per aspect ratio, not once and reused: a 9:16 Shorts
        // caption sits over a vertical crop with far less horizontal room than
        // the same words in a 16:9 pre-roll.
        const { script, source } = await generateScript(
          {
            businessName: campaign.businessName,
            businessCategory: campaign.businessCategory,
            callToAction: campaign.callToAction,
            offerDetails: campaign.offerDetails,
            targetZipCodes: campaign.targetZipCodes,
            radiusMiles: campaign.radiusMiles,
            aspectRatio,
            assetCount: orderedKeys.length,
          },
          (msg, err) => req.log.warn({ err, campaignId }, msg),
        );

        const [creative] = await db
          .insert(creatives)
          .values({
            campaignId,
            aspectRatio,
            script,
            scriptSource: source,
            sourceAssetKeys: orderedKeys,
          })
          .returning();

        await enqueueRender(creative.id);
        created.push(creative);
      }

      await db
        .update(campaigns)
        .set({ status: "rendering", updatedAt: new Date() })
        .where(eq(campaigns.id, campaignId));

      return reply.code(202).send({ creatives: created });
    },
  );

  app.get(
    "/campaigns/:campaignId/creatives",
    { schema: { params: z.object({ campaignId: z.string().uuid() }) } },
    async (req, reply) => {
      const { campaignId } = req.params as { campaignId: string };
      if (!(await loadOwnedCampaign(campaignId, req.userId!, reply))) return;
      return db.select().from(creatives).where(eq(creatives.campaignId, campaignId));
    },
  );

  // Lets an advertiser fix the copy without regenerating. The script is
  // re-validated against the same schema the generator's output goes through,
  // so hand-edited text can't hand the renderer a 500-character caption or an
  // asset index that doesn't exist.
  app.patch(
    "/creatives/:creativeId/script",
    {
      schema: {
        params: z.object({ creativeId: z.string().uuid() }),
        body: z.object({ script: adScriptSchema }),
      },
    },
    async (req, reply) => {
      const { creativeId } = req.params as { creativeId: string };
      const owned = await loadOwnedCreative(creativeId, req.userId!, reply);
      if (!owned) return;

      const { script } = req.body as { script: z.infer<typeof adScriptSchema> };
      const maxIndex = Math.max(owned.creative.sourceAssetKeys.length - 1, 0);
      if (script.scenes.some((s) => s.assetIndex > maxIndex)) {
        return reply.code(400).send({ error: "asset_index_out_of_range" });
      }

      const [updated] = await db
        .update(creatives)
        .set({ script, scriptSource: "manual", renderStatus: "queued", renderError: null })
        .where(eq(creatives.id, creativeId))
        .returning();

      await enqueueRender(creativeId);
      return reply.code(202).send(updated);
    },
  );

  // Re-queue a failed render. Cheap to offer and it is the right answer for
  // the common failure — a transient R2 or ffmpeg hiccup on one of the two
  // creatives while the other rendered fine.
  app.post(
    "/creatives/:creativeId/retry",
    { schema: { params: z.object({ creativeId: z.string().uuid() }) } },
    async (req, reply) => {
      const { creativeId } = req.params as { creativeId: string };
      const owned = await loadOwnedCreative(creativeId, req.userId!, reply);
      if (!owned) return;
      if (owned.creative.renderStatus === "rendering") {
        return reply.code(409).send({ error: "already_rendering" });
      }

      await db
        .update(creatives)
        .set({ renderStatus: "queued", renderError: null })
        .where(eq(creatives.id, creativeId));
      await enqueueRender(creativeId);

      return reply.code(202).send({ ok: true });
    },
  );

  // Short-lived URL for the rendered MP4 or its poster frame — used by the
  // dashboard's preview player and the download button. Authorized by the
  // key's campaign prefix, so a caller can only reach their own campaigns'
  // objects even if they guess a key.
  app.post(
    "/creatives/download-url",
    { schema: { body: z.object({ key: z.string().min(1).max(300) }) } },
    async (req, reply) => {
      const { key } = req.body as { key: string };
      const campaignId = campaignIdForCreativeKey(key);
      if (!campaignId) return reply.code(400).send({ error: "invalid_key" });
      if (!(await loadOwnedCampaign(campaignId, req.userId!, reply))) return;

      return { url: await presignDownload(key) };
    },
  );
}

import { eq } from "drizzle-orm";
import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAdmin, requireAuth } from "../auth/plugin.js";
import { db } from "../db/index.js";
import { creatives } from "../db/schema.js";
import { loadOwnedCampaign, loadOwnedCreative } from "../lib/ownership.js";
import {
  MAX_UPLOAD_VIDEO_BYTES,
  UPLOAD_VIDEO_CONTENT_TYPE,
  checkUploadedVideo,
} from "../lib/uploads/policy.js";
import { creativeVideoKey, deleteObject, headObject, presignUpload } from "../plugins/r2.js";
import { enqueueYoutubeUpload } from "../render/youtubeJobs.js";

// Admin-only: attach a finished MP4 (made outside AdVault, e.g. our own brand
// ad) to a campaign as a ready creative. It skips the renderer and joins the
// normal chain: YouTube upload queue -> launch.
//
// Step 1 of "bring your own video". Customers cannot reach it: requireAdmin,
// AND the campaign must belong to the admin, so this is never a way to put a
// video into someone else's campaign. Customer uploads need a review queue first.
//
// Two calls, like photo uploads: presign, the browser PUTs to R2, then confirm.
// The row is only created on confirm, after HEAD proves the object exists, so
// the YouTube worker can never pick up a creative whose MP4 isn't there yet.

const metaSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  durationSeconds: z.number().positive(),
});

export async function uploadRoutes(app: FastifyInstance) {
  app.addHook("onRequest", requireAuth);

  app.post(
    "/campaigns/:campaignId/creatives/upload-url",
    {
      preHandler: requireAdmin,
      schema: { params: z.object({ campaignId: z.string().uuid() }), body: metaSchema },
    },
    async (req, reply) => {
      const { campaignId } = req.params as { campaignId: string };
      const campaign = await loadOwnedCampaign(campaignId, req.userId!, reply);
      if (!campaign) return;
      if (campaign.status === "live") return reply.code(409).send({ error: "campaign_is_live" });

      // Checked here too so a bad file is refused before it is uploaded.
      const check = checkUploadedVideo(req.body as z.infer<typeof metaSchema>);
      if (!check.ok) return reply.code(400).send({ error: check.error });

      const creativeId = crypto.randomUUID();
      const key = creativeVideoKey(campaignId, creativeId);
      const uploadUrl = await presignUpload(key, UPLOAD_VIDEO_CONTENT_TYPE);
      return { creativeId, uploadUrl, contentType: UPLOAD_VIDEO_CONTENT_TYPE };
    },
  );

  app.post(
    "/campaigns/:campaignId/creatives/upload",
    {
      preHandler: requireAdmin,
      schema: {
        params: z.object({ campaignId: z.string().uuid() }),
        body: metaSchema.extend({ creativeId: z.string().uuid() }),
      },
    },
    async (req, reply) => {
      const { campaignId } = req.params as { campaignId: string };
      const body = req.body as z.infer<typeof metaSchema> & { creativeId: string };
      const campaign = await loadOwnedCampaign(campaignId, req.userId!, reply);
      if (!campaign) return;
      if (campaign.status === "live") return reply.code(409).send({ error: "campaign_is_live" });

      const check = checkUploadedVideo(body);
      if (!check.ok) return reply.code(400).send({ error: check.error });

      // The key is derived from the campaign we just checked, never taken from
      // the client, so a confirm cannot point at another campaign's object.
      const key = creativeVideoKey(campaignId, body.creativeId);
      const object = await headObject(key);
      if (!object) return reply.code(400).send({ error: "upload_missing" });
      if (object.sizeBytes > MAX_UPLOAD_VIDEO_BYTES) return reply.code(400).send({ error: "too_large" });
      if (object.contentType !== UPLOAD_VIDEO_CONTENT_TYPE) {
        return reply.code(400).send({ error: "unsupported_content_type" });
      }

      const [row] = await db
        .insert(creatives)
        .values({
          id: body.creativeId,
          campaignId,
          aspectRatio: check.aspectRatio,
          kind: "upload",
          renderStatus: "ready",
          videoKey: key,
          durationSeconds: Math.round(body.durationSeconds),
          sizeBytes: object.sizeBytes,
          renderedAt: new Date(),
        })
        .onConflictDoNothing()
        .returning();
      if (!row) return reply.code(409).send({ error: "already_uploaded" });

      await enqueueYoutubeUpload(row.id);
      req.log.info({ campaignId, creativeId: row.id, sizeBytes: object.sizeBytes }, "admin video uploaded");
      return reply.code(201).send(row);
    },
  );

  // Remove an uploaded video before launch (e.g. to replace it with a new cut).
  // Only uploads, only admins, only on their own campaigns, and never once the
  // campaign or the ad exists at Google: a live ad points at this video.
  // The YouTube copy stays on the channel; it is unlisted and serves nothing.
  app.delete(
    "/creatives/:creativeId",
    { preHandler: requireAdmin, schema: { params: z.object({ creativeId: z.string().uuid() }) } },
    async (req, reply) => {
      const { creativeId } = req.params as { creativeId: string };
      const owned = await loadOwnedCreative(creativeId, req.userId!, reply);
      if (!owned) return;
      const { creative, campaign } = owned;
      if (creative.kind !== "upload") return reply.code(409).send({ error: "not_an_upload" });
      if (creative.googleAdResourceName || campaign.status === "live") {
        return reply.code(409).send({ error: "creative_is_live" });
      }
      if (creative.youtubeUploadStatus === "uploading") {
        return reply.code(409).send({ error: "upload_in_progress" });
      }

      // Render and upload jobs cascade with the row.
      await db.delete(creatives).where(eq(creatives.id, creativeId));
      if (creative.videoKey) {
        await deleteObject(creative.videoKey).catch((err) =>
          req.log.warn({ err, creativeId }, "uploaded video object not deleted"),
        );
      }
      req.log.info({ creativeId, campaignId: campaign.id }, "admin removed uploaded video");
      return reply.code(204).send();
    },
  );
}

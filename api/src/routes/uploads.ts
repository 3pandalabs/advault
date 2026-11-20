import { lockCampaignUploads, queueOtherFormat } from "../lib/uploads/otherFormat.js";
import { isReformatCopy, otherAspect, shapeUploadPlan } from "../lib/uploads/reformatPolicy.js";
import { deleteUploadObjects, type RemovedObjects } from "../lib/uploads/remove.js";
import { and, eq, inArray, sql } from "drizzle-orm";
import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../auth/plugin.js";
import { db } from "../db/index.js";
import { creatives } from "../db/schema.js";
import { env } from "../env.js";
import { notifyOps } from "../lib/ops/notify.js";
import { loadOwnedCampaign, loadOwnedCreative } from "../lib/ownership.js";
import { passComplianceGate, recordAttestation } from "../lib/compliance/index.js";
import {
  MAX_UPLOAD_VIDEO_BYTES,
  UPLOAD_VIDEO_CONTENT_TYPE,
  checkUploadedVideo,
  uploadLimitsFor,
} from "../lib/uploads/policy.js";
import { initialReviewStatus, ownVideoAllowed } from "../lib/uploads/review.js";
import { billingIdentity, customerFlowRole } from "../lib/testMode/index.js";
import { accountLabel } from "../lib/testMode/policy.js";
import { creativeVideoKey, headObject, presignUpload } from "../plugins/r2.js";
import { enqueueYoutubeUpload } from "../render/youtubeJobs.js";

// "Use my own video": attach a finished MP4 (made outside AdVault) to a
// campaign as a ready creative. It skips the renderer and joins the normal
// chain: YouTube upload queue -> launch.
//
// Open to every user since 2026-11-12, behind a HUMAN REVIEW: a customer's
// upload is inserted `pending_review`, is NOT published to YouTube, and blocks
// launch (video_pending_review) until an AdVault admin approves it in
// routes/videoReviews.ts. Approval is what queues the YouTube upload — an
// unreviewed video never reaches the org's channel, where a copyright strike
// would land on us. An admin's own upload is approved on insert.
//
// The campaign must belong to the caller, so this is never a way to put a
// video into someone else's campaign.
//
// Both shapes (2026-11-19): the owner may upload a 9:16 AND a 16:9, one of
// each. A second video in a shape they already uploaded is 409
// already_uploaded (remove it to replace it). If AdVault's blurred copy
// (lib/uploads/otherFormat.ts) is in that shape, queued, rendering or ready,
// the owner's file replaces it: the copy row (and its render job) is deleted
// and its R2 objects removed, under the campaign row lock that queueOtherFormat
// also takes. Only admins and internal accounts see the second upload in the
// web app, but the rule is the same for anyone allowed to upload.
//
// Two calls, like photo uploads: presign, the browser PUTs to R2, then confirm.
// The row is only created on confirm, after HEAD proves the object exists, so
// the YouTube worker can never pick up a creative whose MP4 isn't there yet.

const metaSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  durationSeconds: z.number().positive(),
});

const confirmSchema = metaSchema.extend({
  creativeId: z.string().uuid(),
  // "I own or have the rights to everything in this video, including the
  // music. No copyrighted music." Required; who and when is stored.
  rightsAttested: z.literal(true),
  // The client's two ticks (lib/compliance): claims true + media rights.
  attestation: z.unknown().optional(),
});

type Db = typeof db;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** The campaign's upload creatives, with what the shape rules and cleanup need. */
function campaignUploads(q: Db | Tx, campaignId: string) {
  return q
    .select({
      id: creatives.id,
      aspectRatio: creatives.aspectRatio,
      renderStatus: creatives.renderStatus,
      renderInfo: creatives.renderInfo,
      googleAdResourceName: creatives.googleAdResourceName,
      youtubeUploadStatus: creatives.youtubeUploadStatus,
      reviewStatus: creatives.reviewStatus,
      videoKey: creatives.videoKey,
      thumbnailKey: creatives.thumbnailKey,
    })
    .from(creatives)
    .where(and(eq(creatives.campaignId, campaignId), eq(creatives.kind, "upload")));
}

export async function uploadRoutes(app: FastifyInstance) {
  app.addHook("onRequest", requireAuth);
  app.addHook("preHandler", async (req, reply) => {
    if (req.method !== "POST") return;
    const role = await customerFlowRole(req);
    if (ownVideoAllowed(role)) return;
    if (ownVideoAllowed(role, (await billingIdentity(req.userId!)).internal)) return;
    return reply.code(403).send({ error: "own_video_paused" });
  });

  app.post(
    "/campaigns/:campaignId/creatives/upload-url",
    { schema: { params: z.object({ campaignId: z.string().uuid() }), body: metaSchema } },
    async (req, reply) => {
      const { campaignId } = req.params as { campaignId: string };
      const campaign = await loadOwnedCampaign(campaignId, req.userId!, reply);
      if (!campaign) return;
      if (campaign.status === "live") return reply.code(409).send({ error: "campaign_is_live" });
      // A removed ad takes no new videos (the ticks are checked on confirm).
      if (!(await passComplianceGate(req, reply, campaign, { attestation: undefined, requireAttestation: false }))) return;

      // Checked here too so a bad file is refused before it is uploaded.
      const check = checkUploadedVideo(req.body as z.infer<typeof metaSchema>, uploadLimitsFor(await customerFlowRole(req)));
      if (!check.ok) return reply.code(400).send({ error: check.error });
      // Refused before the file is uploaded too; confirm re-checks under the lock.
      const plan = shapeUploadPlan(await campaignUploads(db, campaignId), check.aspectRatio);
      if (!plan.ok) return reply.code(409).send({ error: plan.error });

      const creativeId = crypto.randomUUID();
      const key = creativeVideoKey(campaignId, creativeId);
      const uploadUrl = await presignUpload(key, UPLOAD_VIDEO_CONTENT_TYPE);
      return { creativeId, uploadUrl, contentType: UPLOAD_VIDEO_CONTENT_TYPE };
    },
  );

  app.post(
    "/campaigns/:campaignId/creatives/upload",
    { schema: { params: z.object({ campaignId: z.string().uuid() }), body: confirmSchema } },
    async (req, reply) => {
      const { campaignId } = req.params as { campaignId: string };
      const body = req.body as z.infer<typeof confirmSchema>;
      const campaign = await loadOwnedCampaign(campaignId, req.userId!, reply);
      if (!campaign) return;
      if (campaign.status === "live") return reply.code(409).send({ error: "campaign_is_live" });
      if (!(await passComplianceGate(req, reply, campaign, { attestation: body.attestation }))) return;

      const check = checkUploadedVideo(body, uploadLimitsFor(await customerFlowRole(req)));
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

      const now = new Date();
      const reviewStatus = initialReviewStatus(await customerFlowRole(req));
      const result = await db.transaction(async (tx) => {
        await lockCampaignUploads(tx, campaignId);
        const existing = await campaignUploads(tx, campaignId);
        // A retried confirm of a video already saved: same answer as before.
        if (existing.some((u) => u.id === body.creativeId)) return { error: "already_uploaded" as const };
        const plan = shapeUploadPlan(existing, check.aspectRatio);
        if (!plan.ok) return { error: plan.error };
        // AdVault's copy in this shape gives way to the owner's own video. Its
        // render job cascades, so the worker never picks it up again; one that
        // is mid-render finds its row gone and discards its output (worker.ts).
        const replaced: RemovedObjects[] = existing.filter((u) => plan.replaceCopyIds.includes(u.id));
        if (replaced.length > 0) await tx.delete(creatives).where(inArray(creatives.id, plan.replaceCopyIds));
        const [inserted] = await tx
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
            renderedAt: now,
            reviewStatus,
            // An admin's own upload: they are the reviewer.
            ...(reviewStatus === "approved" ? { reviewedBy: req.userId!, reviewedAt: now } : {}),
            rightsAttestedBy: req.userId!,
            rightsAttestedAt: now,
          })
          .onConflictDoNothing()
          .returning();
        if (!inserted) return { error: "already_uploaded" as const };
        return { row: inserted, replaced };
      });
      if ("error" in result) return reply.code(409).send({ error: result.error });
      const { row, replaced } = result;
      await recordAttestation({ req, campaign, action: "upload", creativeId: row.id, assetKeys: [key] });
      if (replaced.length > 0) {
        await deleteUploadObjects(replaced);
        req.log.info({ campaignId, creativeId: row.id, replaced: replaced.map((r) => r.id) }, "owner video replaced the AdVault copy");
      }

      if (reviewStatus === "approved") {
        await enqueueYoutubeUpload(row.id);
        // AdVault makes the other shape from it, unless they uploaded that
        // shape themselves (queueOtherFormat skips then).
        await queueOtherFormat(row.id);
      } else {
        // Same operator channel as platform billing (ntfy). Never throws.
        // An admin's test customer (0030): say so, it is not a real review.
        const who = await billingIdentity(req.userId!);
        await notifyOps({
          title: `AdVault: video to review for ${accountLabel(campaign.businessName, who)}`,
          message: `${campaign.businessName} uploaded their own ${check.aspectRatio} video (${Math.round(body.durationSeconds)}s) for "${campaign.name}". Approve or reject it before they can launch.`,
          priority: 3,
          tags: ["movie_camera"],
          click: `${env.WEB_ORIGIN}/dashboard/admin/reviews`,
        });
      }

      req.log.info(
        { campaignId, creativeId: row.id, sizeBytes: object.sizeBytes, reviewStatus },
        "video uploaded",
      );
      return reply.code(201).send(row);
    },
  );

  // Remove an uploaded video before launch (e.g. to replace a rejected cut, or
  // either of the owner's two shapes). AdVault's copies made from it go too.
  // Only uploads, only on the caller's own campaigns, and never once the
  // campaign or the ad exists at Google: a live ad points at this video.
  // A YouTube copy, if approval published one, stays on the channel; it is
  // unlisted and serves nothing.
  app.delete(
    "/creatives/:creativeId",
    { schema: { params: z.object({ creativeId: z.string().uuid() }) } },
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

      // AdVault's copies made FROM this video go with it: their source file is
      // about to be deleted, so a queued one could never render. Same guards.
      const copies = isReformatCopy(creative.renderInfo)
        ? []
        : await db
            .select({
              id: creatives.id,
              videoKey: creatives.videoKey,
              thumbnailKey: creatives.thumbnailKey,
              googleAdResourceName: creatives.googleAdResourceName,
              youtubeUploadStatus: creatives.youtubeUploadStatus,
            })
            .from(creatives)
            .where(
              and(
                eq(creatives.campaignId, campaign.id),
                eq(creatives.kind, "upload"),
                sql`${creatives.renderInfo}->>'engine' = 'reformat' and ${creatives.renderInfo}->>'from' = ${creativeId}`,
              ),
            );
      if (copies.some((c) => c.googleAdResourceName)) return reply.code(409).send({ error: "creative_is_live" });
      if (copies.some((c) => c.youtubeUploadStatus === "uploading")) {
        return reply.code(409).send({ error: "upload_in_progress" });
      }

      // Render and upload jobs cascade with the rows.
      const removed: RemovedObjects[] = [creative, ...copies];
      await db.delete(creatives).where(inArray(creatives.id, removed.map((r) => r.id)));
      await deleteUploadObjects(removed);

      // Removing their own video in one shape while they keep their own in the
      // other: AdVault's copy comes back for the removed shape (as if they had
      // uploaded only one), and an upload of their own replaces it again.
      const target = isReformatCopy(creative.renderInfo) ? null : otherAspect(creative.aspectRatio);
      if (target) {
        const keep = (await campaignUploads(db, campaign.id)).find(
          (u) => u.aspectRatio === target && !isReformatCopy(u.renderInfo) && u.reviewStatus === "approved",
        );
        if (keep) await queueOtherFormat(keep.id);
      }
      req.log.info({ creativeId, campaignId: campaign.id }, "uploaded video removed");
      return reply.code(204).send();
    },
  );
}

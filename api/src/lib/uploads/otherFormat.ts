// "Use my own video" asks for ONE video. AdVault makes the other shape from it
// (2026-11-16): the owner's video plays sharp in the middle over a blurred,
// enlarged copy of itself, so the ad can run on Shorts AND in-stream. Free:
// ffmpeg on the renderer (render/reformat.ts). The copy is made from an
// APPROVED upload, so it is approved too (same footage, no new content).
//
// The copy is a kind = 'upload' creative inserted 'queued' with the source
// video's key as its only source asset and renderInfo.engine = 'reformat';
// the render worker branches on that. Normal uploads are inserted 'ready' and
// never get a render job.

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { campaigns, creatives } from "../../db/schema.js";
import { enqueueRender } from "../../render/jobs.js";

import { isReformatCopy, needsReformatCopy, otherAspect, REFORMAT_ENGINE } from "./reformatPolicy.js";

export { isReformatCopy, otherAspect };

/**
 * After an upload is approved: queue the other shape, unless the campaign
 * already has an upload in that shape. The owner's own upload in that shape
 * (any review state, 2026-11-19: internal accounts and admins may upload both)
 * always wins: no copy is made. A not-failed copy also skips. Never throws.
 */
export async function queueOtherFormat(sourceId: string): Promise<string | null> {
  try {
    const [src] = await db.select().from(creatives).where(eq(creatives.id, sourceId)).limit(1);
    if (!src || src.kind !== "upload" || src.reviewStatus !== "approved" || !src.videoKey) return null;
    if (isReformatCopy(src.renderInfo)) return null;
    const target = otherAspect(src.aspectRatio);
    if (!target) return null;
    const srcVideoKey = src.videoKey;
    // Under the campaign row lock, the same one an owner's upload takes
    // (lockCampaignUploads), so a copy and the owner's own video in the same
    // shape can never both be inserted.
    const id = await db.transaction(async (tx) => {
      await lockCampaignUploads(tx, src.campaignId);
      const existing = await tx
        .select({
          id: creatives.id,
          aspectRatio: creatives.aspectRatio,
          renderStatus: creatives.renderStatus,
          renderInfo: creatives.renderInfo,
        })
        .from(creatives)
        .where(and(eq(creatives.campaignId, src.campaignId), eq(creatives.kind, "upload"), eq(creatives.aspectRatio, target)));
      if (!needsReformatCopy(existing)) return null;
      const newId = randomUUID();
      const now = new Date();
      await tx.insert(creatives).values({
        id: newId,
        campaignId: src.campaignId,
        aspectRatio: target,
        kind: "upload",
        renderStatus: "queued",
        sourceAssetKeys: [srcVideoKey],
        durationSeconds: src.durationSeconds,
        reviewStatus: "approved",
        reviewedBy: src.reviewedBy,
        reviewedAt: now,
        rightsAttestedBy: src.rightsAttestedBy,
        rightsAttestedAt: src.rightsAttestedAt,
        renderInfo: { engine: REFORMAT_ENGINE, from: src.id },
      });
      return newId;
    });
    if (!id) return null;
    await enqueueRender(id);
    return id;
  } catch (err) {
    console.error(JSON.stringify({ msg: "queue other format failed", sourceId, error: String(err) }));
    return null;
  }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Serialises upload changes on one campaign (an owner's upload, a copy being
 * queued): SELECT ... FOR UPDATE on the campaign row, held to the end of `tx`.
 */
export async function lockCampaignUploads(tx: Tx, campaignId: string): Promise<void> {
  await tx.select({ id: campaigns.id }).from(campaigns).where(eq(campaigns.id, campaignId)).for("update");
}

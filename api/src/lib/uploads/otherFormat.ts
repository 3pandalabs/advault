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
import { and, eq, ne } from "drizzle-orm";
import { db } from "../../db/index.js";
import { creatives } from "../../db/schema.js";
import { enqueueRender } from "../../render/jobs.js";

import { isReformatCopy, otherAspect, REFORMAT_ENGINE } from "./reformatPolicy.js";

export { isReformatCopy, otherAspect };

/**
 * After an upload is approved: queue the other shape, unless the campaign
 * already has an upload in that shape (theirs or a copy). Never throws.
 */
export async function queueOtherFormat(sourceId: string): Promise<string | null> {
  try {
    const [src] = await db.select().from(creatives).where(eq(creatives.id, sourceId)).limit(1);
    if (!src || src.kind !== "upload" || src.reviewStatus !== "approved" || !src.videoKey) return null;
    if (isReformatCopy(src.renderInfo)) return null;
    const target = otherAspect(src.aspectRatio);
    if (!target) return null;
    const existing = await db
      .select({ id: creatives.id })
      .from(creatives)
      .where(
        and(
          eq(creatives.campaignId, src.campaignId),
          eq(creatives.kind, "upload"),
          eq(creatives.aspectRatio, target),
          ne(creatives.renderStatus, "failed"),
        ),
      )
      .limit(1);
    if (existing.length > 0) return null;
    const id = randomUUID();
    const now = new Date();
    await db.insert(creatives).values({
      id,
      campaignId: src.campaignId,
      aspectRatio: target,
      kind: "upload",
      renderStatus: "queued",
      sourceAssetKeys: [src.videoKey],
      durationSeconds: src.durationSeconds,
      reviewStatus: "approved",
      reviewedBy: src.reviewedBy,
      reviewedAt: now,
      rightsAttestedBy: src.rightsAttestedBy,
      rightsAttestedAt: src.rightsAttestedAt,
      renderInfo: { engine: REFORMAT_ENGINE, from: src.id },
    });
    await enqueueRender(id);
    return id;
  } catch (err) {
    console.error(JSON.stringify({ msg: "queue other format failed", sourceId, error: String(err) }));
    return null;
  }
}

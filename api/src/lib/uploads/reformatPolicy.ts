// Pure rules for the other-shape copy of an owner upload (otherFormat.ts).

export type UploadAspect = "16:9" | "9:16";

export const REFORMAT_ENGINE = "reformat";

export function otherAspect(a: string): UploadAspect | null {
  return a === "16:9" ? "9:16" : a === "9:16" ? "16:9" : null;
}

/** Was this creative made by AdVault from the owner's other-shape video? */
export function isReformatCopy(renderInfo: unknown): boolean {
  return (renderInfo as { engine?: unknown } | null)?.engine === REFORMAT_ENGINE;
}

/** An upload creative already on the campaign, as far as these rules need it. */
export type ShapeUpload = {
  id: string;
  aspectRatio: string;
  renderStatus: string;
  renderInfo: unknown;
  googleAdResourceName?: string | null;
  youtubeUploadStatus?: string | null;
};

export type ShapeUploadPlan =
  | { ok: true; replaceCopyIds: string[] }
  | { ok: false; error: "already_uploaded" | "creative_is_live" | "upload_in_progress" };

/**
 * May the owner upload their own video in `aspect`? (2026-11-19: both shapes.)
 *
 * - Their own upload already in that shape: 409 already_uploaded (remove it to
 *   replace it).
 * - AdVault's blurred copy in that shape (queued, rendering, ready or failed):
 *   the owner's file takes its place, so the copies are returned to remove.
 *   Not while the copy is in a Google ad or mid-upload to YouTube.
 * - Nothing in that shape: a plain upload, as before.
 */
export function shapeUploadPlan(existing: ShapeUpload[], aspect: string): ShapeUploadPlan {
  const same = existing.filter((u) => u.aspectRatio === aspect);
  if (same.some((u) => !isReformatCopy(u.renderInfo))) return { ok: false, error: "already_uploaded" };
  if (same.some((u) => u.googleAdResourceName)) return { ok: false, error: "creative_is_live" };
  if (same.some((u) => u.youtubeUploadStatus === "uploading")) return { ok: false, error: "upload_in_progress" };
  return { ok: true, replaceCopyIds: same.map((u) => u.id) };
}

/**
 * Should AdVault make a copy in the target shape? Never when the owner has
 * uploaded that shape themselves (whatever its review state), and not when a
 * live (not failed) copy is already there.
 */
export function needsReformatCopy(targetShapeUploads: ShapeUpload[]): boolean {
  if (targetShapeUploads.some((u) => !isReformatCopy(u.renderInfo))) return false;
  return !targetShapeUploads.some((u) => u.renderStatus !== "failed");
}

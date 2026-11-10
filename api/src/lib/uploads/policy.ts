// Pure rules for an admin-uploaded, finished ad video (no db, no R2).
//
// Step 1 of "bring your own video" is admin-only, so these checks are about
// catching mistakes, not hostile input: a 4:5 export, a 3-hour screen
// recording, a .mov renamed to .mp4. Customer uploads (step 2) will add a
// human review queue on top.

export const MAX_UPLOAD_VIDEO_BYTES = 200 * 1024 * 1024;
export const MIN_UPLOAD_VIDEO_SECONDS = 5;
export const MAX_UPLOAD_VIDEO_SECONDS = 180;
export const UPLOAD_VIDEO_CONTENT_TYPE = "video/mp4";

export type UploadedVideoMeta = { width: number; height: number; durationSeconds: number };

export type UploadCheck =
  | { ok: true; aspectRatio: "16:9" | "9:16" }
  | { ok: false; error: "unsupported_aspect_ratio" | "too_short" | "too_long" | "too_small" };

// Within 2% of exact, so 1080x1920, 720x1280 and 1080x1916 all pass.
const near = (a: number, b: number) => Math.abs(a - b) / b <= 0.02;

export function checkUploadedVideo(meta: UploadedVideoMeta): UploadCheck {
  const { width, height, durationSeconds } = meta;
  if (durationSeconds < MIN_UPLOAD_VIDEO_SECONDS) return { ok: false, error: "too_short" };
  if (durationSeconds > MAX_UPLOAD_VIDEO_SECONDS) return { ok: false, error: "too_long" };
  if (Math.min(width, height) < 720) return { ok: false, error: "too_small" };
  const r = width / height;
  if (near(r, 9 / 16)) return { ok: true, aspectRatio: "9:16" };
  if (near(r, 16 / 9)) return { ok: true, aspectRatio: "16:9" };
  return { ok: false, error: "unsupported_aspect_ratio" };
}

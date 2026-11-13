// Pure rules for an uploaded, finished ad video (no db, no R2).
//
// Mostly about catching mistakes rather than hostile input: a 4:5 export, a
// 3-hour screen recording, a .mov renamed to .mp4. What is IN the video is a
// human's job — see review.ts.

export const MAX_UPLOAD_VIDEO_BYTES = 200 * 1024 * 1024;
export const UPLOAD_VIDEO_CONTENT_TYPE = "video/mp4";

export type UploadLimits = { minSeconds: number; maxSeconds: number };

// Customers: a short local ad. 6s is YouTube's bumper floor; past 60s a
// Shorts placement stops being a Short, and a long in-stream ad from a local
// shop is almost always a mistake (a whole promo reel, a screen recording).
export const CUSTOMER_UPLOAD_LIMITS: UploadLimits = { minSeconds: 6, maxSeconds: 60 };
// Admins (AdVault's own brand ads) keep the original, wider window.
export const ADMIN_UPLOAD_LIMITS: UploadLimits = { minSeconds: 5, maxSeconds: 180 };

export function uploadLimitsFor(role: string | undefined): UploadLimits {
  return role === "admin" ? ADMIN_UPLOAD_LIMITS : CUSTOMER_UPLOAD_LIMITS;
}

export type UploadedVideoMeta = { width: number; height: number; durationSeconds: number };

export type UploadCheck =
  | { ok: true; aspectRatio: "16:9" | "9:16" }
  | { ok: false; error: "unsupported_aspect_ratio" | "too_short" | "too_long" | "too_small" };

// Within 2% of exact, so 1080x1920, 720x1280 and 1080x1916 all pass.
const near = (a: number, b: number) => Math.abs(a - b) / b <= 0.02;

export function checkUploadedVideo(
  meta: UploadedVideoMeta,
  limits: UploadLimits = ADMIN_UPLOAD_LIMITS,
): UploadCheck {
  const { width, height, durationSeconds } = meta;
  if (durationSeconds < limits.minSeconds) return { ok: false, error: "too_short" };
  if (durationSeconds > limits.maxSeconds) return { ok: false, error: "too_long" };
  if (Math.min(width, height) < 720) return { ok: false, error: "too_small" };
  const r = width / height;
  if (near(r, 9 / 16)) return { ok: true, aspectRatio: "9:16" };
  if (near(r, 16 / 9)) return { ok: true, aspectRatio: "16:9" };
  return { ok: false, error: "unsupported_aspect_ratio" };
}

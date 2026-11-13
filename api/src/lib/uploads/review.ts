// Pure rules for the human review of customer-uploaded videos (no db, no R2).
//
// Any user can upload a finished MP4 (routes/uploads.ts), but a video made
// outside AdVault is the one thing in this product we did not make ourselves,
// and it runs in a paid placement under our name and on the org's YouTube
// channel. So an AdVault admin approves every one before it is published to
// YouTube or launched. AdVault-generated creatives have reviewStatus NULL and
// are never affected by anything here.
//
// TODO(future): an automated pre-screen could sit in front of the human queue,
// e.g. Google Video Intelligence explicit-content detection (~5¢ per video).
// Deliberately NOT integrated — a paid API per upload is not worth it at the
// current volume, and it would not replace the human check (music rights).

export type ReviewStatus = "pending_review" | "approved" | "rejected";

export const REJECT_REASON_MAX = 500;

/**
 * An admin's own upload is approved on insert: they are the reviewer, and
 * admin uploads (e.g. AdVault's brand ad) predate the review queue.
 */
export function initialReviewStatus(role: string | undefined): ReviewStatus {
  return role === "admin" ? "approved" : "pending_review";
}

export type ReviewDecision = { decision: "approve" } | { decision: "reject"; reason: string };

export type ReviewTransition =
  | { ok: true; next: "approved" | "rejected"; reason: string | null }
  | { ok: false; error: "not_reviewable" | "already_reviewed" | "reason_required" };

/**
 * pending_review -> approved | rejected, and nothing else. A decided video is
 * final: approval may already have published it to YouTube, and a rejected
 * customer uploads a new file rather than re-litigating the old one.
 */
export function reviewTransition(current: ReviewStatus | null, input: ReviewDecision): ReviewTransition {
  if (current === null) return { ok: false, error: "not_reviewable" };
  if (current !== "pending_review") return { ok: false, error: "already_reviewed" };
  if (input.decision === "approve") return { ok: true, next: "approved", reason: null };
  const reason = input.reason.trim().slice(0, REJECT_REASON_MAX);
  if (!reason) return { ok: false, error: "reason_required" };
  return { ok: true, next: "rejected", reason };
}

/** Only approved uploads (and everything AdVault generated) may reach YouTube. */
export function mayPublishToYoutube(reviewStatus: ReviewStatus | null): boolean {
  return reviewStatus === null || reviewStatus === "approved";
}

export type LaunchCandidate = { id: string; reviewStatus: ReviewStatus | null };

export type LaunchReviewGate =
  | { ok: true; eligibleIds: string[] }
  | { ok: false; error: "video_pending_review" | "video_rejected" };

/**
 * Which of a campaign's ready creatives may go into the launch.
 *
 * - Any upload still pending blocks: the advertiser meant it to be in the ad,
 *   and launching without it would silently run something else.
 * - Rejected uploads are left out. If that leaves nothing, the launch is
 *   refused with video_rejected rather than the generic no_ready_creatives.
 */
export function launchReviewGate(candidates: LaunchCandidate[]): LaunchReviewGate {
  if (candidates.some((c) => c.reviewStatus === "pending_review")) {
    return { ok: false, error: "video_pending_review" };
  }
  const eligible = candidates.filter((c) => mayPublishToYoutube(c.reviewStatus));
  if (eligible.length === 0 && candidates.some((c) => c.reviewStatus === "rejected")) {
    return { ok: false, error: "video_rejected" };
  }
  return { ok: true, eligibleIds: eligible.map((c) => c.id) };
}

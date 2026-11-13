"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  ApiError,
  decideVideoReview,
  getMe,
  listVideoReviews,
  type VideoReview,
  type VideoReviewStatus,
} from "@/lib/api/browser";
import { Badge, Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

// Admin-only: the review queue for customer-uploaded videos, from
// GET /admin/video-reviews (which enforces admin itself; this page only hides
// the UI from others). Approving publishes the video to YouTube and unlocks
// the customer's Launch; rejecting shows them the reason.
//
// What to check: no copyrighted music or footage, nothing misleading, offensive
// or adult, and that it is actually an ad for this business. Google reviews the
// ad again after launch, but a disapproval there costs the customer a day.

const TABS: { status: VideoReviewStatus; label: string }[] = [
  { status: "pending_review", label: "Pending" },
  { status: "approved", label: "Approved" },
  { status: "rejected", label: "Rejected" },
];

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "—");

export default function AdminVideoReviewsPage() {
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [status, setStatus] = useState<VideoReviewStatus>("pending_review");
  const [videos, setVideos] = useState<VideoReview[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getMe()
      .then((me) => setAllowed(me.role === "admin"))
      .catch(() => setAllowed(false));
  }, []);

  // Bumped after a decision to reload the current tab.
  const [reloads, setReloads] = useState(0);
  const reload = useCallback(() => setReloads((n) => n + 1), []);

  useEffect(() => {
    if (!allowed) return;
    let cancelled = false;
    listVideoReviews(status)
      .then((d) => {
        if (cancelled) return;
        setVideos(d.videos);
        setError(null);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.code : "request_failed");
      });
    return () => {
      cancelled = true;
    };
  }, [allowed, status, reloads]);

  if (allowed === null) return <p className="text-sm text-zinc-500">Loading…</p>;
  if (!allowed) return <p className="text-sm text-zinc-400">This page is for AdVault admins.</p>;

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Video reviews</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Customer-uploaded videos. Nothing is published or launched until it is approved here.{" "}
            <Link href="/dashboard/admin" className="text-amber-300 hover:underline">
              Ad performance →
            </Link>
          </p>
        </div>
        <div className="flex rounded-lg border border-white/15 p-0.5 text-sm">
          {TABS.map((t) => (
            <button
              key={t.status}
              type="button"
              onClick={() => {
                if (t.status === status) return;
                setVideos(null);
                setStatus(t.status);
              }}
              className={
                status === t.status
                  ? "rounded-md bg-amber-400 px-3 py-1 font-medium text-zinc-950"
                  : "rounded-md px-3 py-1 text-zinc-400 hover:text-zinc-200"
              }
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <p className="mb-4 rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2 text-sm text-red-200">
          Could not load videos ({error}).
        </p>
      )}
      {!videos && !error && <p className="text-sm text-zinc-500">Loading…</p>}
      {videos && videos.length === 0 && (
        <Card>
          <CardTitle>Nothing here</CardTitle>
          <CardDescription>
            {status === "pending_review" ? "No videos are waiting for review." : "No videos yet."}
          </CardDescription>
        </Card>
      )}

      <div className="space-y-4">
        {videos?.map((v) => <ReviewCard key={v.creativeId} video={v} onDecided={reload} />)}
      </div>
    </div>
  );
}

function ReviewCard({ video: v, onDecided }: { video: VideoReview; onDecided: () => void }) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(input: { decision: "approve" } | { decision: "reject"; reason: string }) {
    setBusy(true);
    setError(null);
    try {
      await decideVideoReview(v.creativeId, input);
      onDecided();
    } catch (err) {
      setError(err instanceof ApiError ? err.code : "request_failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle>
            <Link href={`/dashboard/campaigns/${v.campaignId}`} className="hover:underline">
              {v.businessName}
            </Link>
          </CardTitle>
          <CardDescription>
            {v.campaignName} · {v.ownerEmail} ·{" "}
            <a href={v.landingUrl} target="_blank" rel="noreferrer" className="hover:underline">
              {v.landingUrl}
            </a>
          </CardDescription>
          <CardDescription>
            {v.aspectRatio === "9:16" ? "Shorts (9:16)" : "Pre-roll (16:9)"} · {v.durationSeconds ?? "?"}s
            {v.sizeBytes ? ` · ${(v.sizeBytes / 1024 / 1024).toFixed(1)} MB` : ""} · uploaded {when(v.createdAt)}
          </CardDescription>
        </div>
        <Badge
          tone={v.reviewStatus === "approved" ? "success" : v.reviewStatus === "rejected" ? "danger" : "pending"}
        >
          {v.reviewStatus === "pending_review" ? "Pending" : v.reviewStatus}
        </Badge>
      </div>

      {v.videoUrl && (
        <video
          controls
          preload="metadata"
          src={v.videoUrl}
          className={`mt-4 rounded-lg border border-white/10 ${v.aspectRatio === "9:16" ? "max-h-[32rem]" : "w-full"}`}
        />
      )}

      <p className="mt-3 text-xs text-zinc-400">
        {v.rightsAttestedAt
          ? `Owner attested on ${when(v.rightsAttestedAt)}: "I own or have the rights to everything in this video, including the music. No copyrighted music."`
          : "No rights attestation recorded."}
      </p>

      {v.reviewStatus !== "pending_review" && (
        <p className="mt-2 text-xs text-zinc-500">
          Reviewed {when(v.reviewedAt)}
          {v.reviewReason ? ` · reason: ${v.reviewReason}` : ""}
        </p>
      )}

      {v.reviewStatus === "pending_review" && (
        <div className="mt-4">
          {rejecting ? (
            <div className="space-y-2">
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={500}
                rows={2}
                placeholder="Reason shown to the customer, e.g. “The background music is a copyrighted song.”"
                className="w-full rounded-lg border border-white/15 bg-zinc-950 px-3 py-2 text-sm text-zinc-100"
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || !reason.trim()}
                  onClick={() => decide({ decision: "reject", reason })}
                >
                  {busy ? "Rejecting…" : "Reject with this reason"}
                </Button>
                <button
                  type="button"
                  className="text-xs text-zinc-500 hover:text-zinc-300"
                  onClick={() => setRejecting(false)}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="flex gap-2">
              <Button size="sm" disabled={busy} onClick={() => decide({ decision: "approve" })}>
                {busy ? "Approving…" : "Approve"}
              </Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => setRejecting(true)}>
                Reject…
              </Button>
            </div>
          )}
          {error && <p className="mt-2 text-sm text-red-300">Could not save ({error}).</p>}
        </div>
      )}
    </Card>
  );
}

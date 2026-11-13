"use client";

import { useRef, useState } from "react";
import { ApiError, uploadCreativeVideo } from "@/lib/api/browser";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

// "Use my own video": attach a finished MP4 to this campaign instead of (or
// as well as) the ad AdVault makes. A customer's upload is reviewed by
// AdVault before it is published or launched; an admin's is approved on
// upload. The API enforces the limits, ownership and the attestation; this
// card mirrors the limits so a bad file is refused before it is uploaded.

// Must match api/src/lib/uploads/policy.ts.
const CUSTOMER_LIMITS = { minSeconds: 6, maxSeconds: 60 };
const ADMIN_LIMITS = { minSeconds: 5, maxSeconds: 180 };

const ATTESTATION =
  "I own or have the rights to everything in this video, including the music. No copyrighted music.";

function errorText(code: string, limits: { minSeconds: number; maxSeconds: number }): string {
  const known: Record<string, string> = {
    not_mp4: "Choose an .mp4 file.",
    unreadable: "This file could not be read as a video.",
    unsupported_aspect_ratio: "The video must be vertical (9:16) or wide (16:9).",
    too_small: "The video must be at least 720p.",
    too_short: `The video must be at least ${limits.minSeconds} seconds.`,
    too_long: `The video must be ${limits.maxSeconds} seconds or shorter.`,
    too_large: "The video must be 200 MB or smaller.",
    upload_failed: "The upload did not finish. Try again.",
    upload_missing: "The upload did not finish. Try again.",
    campaign_is_live: "This campaign is already live, so no videos can be added.",
  };
  return known[code] ?? `Upload failed (${code}).`;
}

export function VideoUpload({
  campaignId,
  isAdmin,
  onUploaded,
}: {
  campaignId: string;
  isAdmin: boolean;
  onUploaded: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [attested, setAttested] = useState(false);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const limits = isAdmin ? ADMIN_LIMITS : CUSTOMER_LIMITS;

  async function onFile(file: File | undefined) {
    if (!file || !attested) return;
    setBusy(true);
    setMessage(null);
    try {
      const creative = await uploadCreativeVideo(campaignId, file, limits);
      setMessage({
        ok: true,
        text:
          creative.reviewStatus === "pending_review"
            ? `Uploaded as a ${creative.aspectRatio} video. AdVault will review it — usually within a day — and Launch unlocks once it's approved.`
            : `Uploaded as a ${creative.aspectRatio} video. Publishing to YouTube…`,
      });
      setAttested(false);
      onUploaded();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : err instanceof Error ? err.message : "error";
      setMessage({ ok: false, text: errorText(code, limits) });
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div className="mt-6">
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          Use my own video
        </Button>
      </div>
    );
  }

  return (
    <Card className="mt-6 border-dashed">
      <CardTitle>Use my own video</CardTitle>
      <CardDescription>
        A finished MP4, vertical (9:16) for Shorts or wide (16:9) for in-stream, at least 720p,{" "}
        {limits.minSeconds}–{limits.maxSeconds} seconds, up to 200 MB.
        {isAdmin
          ? " As an admin, your upload is approved straight away."
          : " AdVault reviews every uploaded video before it can run, usually within a day. Google then reviews the ad again after launch."}
      </CardDescription>
      <label className="mt-4 flex items-start gap-2 text-sm text-zinc-300">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={attested}
          onChange={(e) => setAttested(e.target.checked)}
        />
        <span>{ATTESTATION}</span>
      </label>
      <div className="mt-3 flex items-center gap-3">
        <input
          ref={input}
          type="file"
          accept="video/mp4"
          className="hidden"
          onChange={(e) => {
            void onFile(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
        <Button variant="outline" size="sm" disabled={busy || !attested} onClick={() => input.current?.click()}>
          {busy ? "Uploading…" : "Choose video"}
        </Button>
        <button
          type="button"
          className="text-xs text-zinc-500 hover:text-zinc-300"
          onClick={() => setOpen(false)}
        >
          Cancel
        </button>
      </div>
      {message && (
        <p className={`mt-3 text-sm ${message.ok ? "text-emerald-300" : "text-red-300"}`}>{message.text}</p>
      )}
    </Card>
  );
}

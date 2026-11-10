"use client";

import { useRef, useState } from "react";
import { ApiError, uploadCreativeVideo } from "@/lib/api/browser";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

// Admin-only: attach a finished MP4 (e.g. AdVault's own brand ad) to this
// campaign. It skips AdVault's video maker and is published to YouTube like
// any other ad. The API enforces admin + campaign ownership; this card is only
// shown to admins so customers never see it.

const ERRORS: Record<string, string> = {
  not_mp4: "Choose an .mp4 file.",
  unreadable: "This file could not be read as a video.",
  unsupported_aspect_ratio: "The video must be vertical (9:16) or wide (16:9).",
  too_small: "The video must be at least 720p.",
  too_short: "The video must be at least 5 seconds.",
  too_long: "The video must be 3 minutes or shorter.",
  too_large: "The video must be 200 MB or smaller.",
  upload_failed: "The upload did not finish. Try again.",
  upload_missing: "The upload did not finish. Try again.",
  campaign_is_live: "This campaign is already live, so no videos can be added.",
};

export function AdminVideoUpload({ campaignId, onUploaded }: { campaignId: string; onUploaded: () => void }) {
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function onFile(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setMessage(null);
    try {
      const creative = await uploadCreativeVideo(campaignId, file);
      setMessage({ ok: true, text: `Uploaded as a ${creative.aspectRatio} video. Publishing to YouTube…` });
      onUploaded();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : err instanceof Error ? err.message : "error";
      setMessage({ ok: false, text: ERRORS[code] ?? `Upload failed (${code}).` });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mt-6 border-dashed">
      <CardTitle>Upload a finished video (admin)</CardTitle>
      <CardDescription>
        MP4, vertical or wide, 5 seconds to 3 minutes, up to 200 MB. It is published to YouTube
        and labelled as AI-made, then used by Launch like any other ad.
      </CardDescription>
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
        <Button variant="outline" size="sm" disabled={busy} onClick={() => input.current?.click()}>
          {busy ? "Uploading…" : "Choose video"}
        </Button>
      </div>
      {message && (
        <p className={`mt-3 text-sm ${message.ok ? "text-emerald-300" : "text-red-300"}`}>{message.text}</p>
      )}
    </Card>
  );
}

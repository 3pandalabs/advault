"use client";

import { useEffect, useState } from "react";
import { aboutMinutes, estimateFraction, estimateOverdue } from "@/lib/estimateProgress";

// A progress bar for an ad being made. Rendering has no live progress feed:
// the renderer reports only queued / rendering / ready. So this is an honest
// ESTIMATE from how long ads usually take (photo polish, AI motion, voice,
// assembly: ~4-5 minutes for the first shape, the second follows), shown so
// a shop owner can see it is working instead of a badge that never changes.
// It never reaches 100% on its own: only the real "ready" status does.

const STAGES: { until: number; label: string }[] = [
  { until: 0.15, label: "Polishing your photos" },
  { until: 0.65, label: "Bringing your photos to life" },
  { until: 0.8, label: "Recording the voiceover" },
  { until: 1, label: "Putting your ad together" },
];

export function RenderProgress({
  createdAt,
  queued,
  expectedSeconds,
}: {
  createdAt: string;
  queued: boolean;
  /** Typical time from creation to ready for this video. */
  expectedSeconds: number;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const elapsed = Math.max(0, (now - Date.parse(createdAt)) / 1000);
  const fraction = Math.min(0.95, elapsed / expectedSeconds);
  const late = elapsed > expectedSeconds;
  const left = Math.max(0, expectedSeconds - elapsed);
  const stage = STAGES.find((s) => fraction < s.until) ?? STAGES[STAGES.length - 1];

  return (
    <div className="mt-4" role="status" aria-live="polite">
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
        <span className="text-zinc-200">{queued ? "Waiting for the other shape to finish" : stage.label}…</span>
        <span className="text-zinc-400">
          {late
            ? "Almost done, taking a little longer than usual"
            : left >= 60
              ? `About ${Math.ceil(left / 60)} min left`
              : "Less than a minute left"}
        </span>
      </div>
      <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-white/10">
        <div
          className="h-full rounded-full bg-amber-400 transition-[width] duration-1000 ease-linear"
          style={{ width: `${Math.round(fraction * 100)}%` }}
        />
      </div>
      <p className="mt-2 text-xs text-zinc-500">
        Ads usually take {Math.round(expectedSeconds / 60)} minutes. You can leave this page; it keeps going.
      </p>
    </div>
  );
}

// The same bar for any step with a known start and a typical length (the
// "Change my offer" card: making the new ad, then publishing it). Time-based
// from the API's start time, so a refresh keeps its place; holds at 95% with
// `overdueText` until the caller's polling sees the real status change.
export function EstimateProgress({
  startedAt,
  expectedSeconds,
  label,
  overdueText = "Almost there, checking…",
  note,
}: {
  startedAt: string;
  expectedSeconds: number;
  label: string;
  overdueText?: string;
  note?: string;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const started = Date.parse(startedAt);
  const fraction = estimateFraction(started, now, expectedSeconds);
  const overdue = estimateOverdue(started, now, expectedSeconds);
  return (
    <div role="status" aria-live="polite">
      <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-white/10">
        <div
          className="h-full rounded-full bg-amber-400 transition-[width] duration-1000 ease-linear"
          style={{ width: `${Math.round(fraction * 100)}%` }}
        />
      </div>
      <p className="mt-2 text-sm text-zinc-300">{overdue ? overdueText : `${label}… ${aboutMinutes(expectedSeconds)}`}</p>
      {note && <p className="mt-1 text-xs text-zinc-500">{note}</p>}
    </div>
  );
}

// The step BEFORE the render: the API writes the script with AI inside the
// generate / redo request itself (~20 s), and only then do the creatives
// (and RenderProgress) exist. Without this the button just greys out and the
// page looks stuck. Same honest-estimate rule: never 100% on its own.
const SCRIPT_SECONDS = 25;

export function ScriptProgress({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);
  const elapsed = Math.max(0, (now - startedAt) / 1000);
  const fraction = Math.min(0.95, elapsed / SCRIPT_SECONDS);
  return (
    <div role="status" aria-live="polite">
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
        <span className="text-zinc-200">
          {elapsed < 8 ? "Looking at your photos" : "Writing your ad script"}…
        </span>
        <span className="text-zinc-400">
          {elapsed > SCRIPT_SECONDS ? "Almost there" : "About 20 seconds"}
        </span>
      </div>
      <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-white/10">
        <div
          className="h-full rounded-full bg-amber-400 transition-[width] duration-500 ease-linear"
          style={{ width: `${Math.round(fraction * 100)}%` }}
        />
      </div>
      <p className="mt-2 text-xs text-zinc-500">
        Next we make the video itself, which takes a few minutes. You can leave this page; it keeps going.
      </p>
    </div>
  );
}

"use client";

import { useState } from "react";
import { uploadAsset } from "@/lib/api/browser";
import { BEFORE_AFTER_ATTESTATION, MAX_BEFORE_AFTER_PAIRS } from "@/lib/beforeAfter";

// "Show your work: before & after" (api lib/beforeAfter). Used by the wizard
// and the campaign page. Photos go through the same upload as every other ad
// photo; they play in the ad exactly as taken (no AI touch-up, no motion).

export type DraftPhoto = { id: string; url: string };
export type DraftPair = { before?: DraftPhoto; after?: DraftPhoto };

/** The pairs ready to save (both photos), as the API takes them. */
export function completePairs(pairs: DraftPair[]): { beforeAssetId: string; afterAssetId: string }[] {
  return pairs.flatMap((p) => (p.before && p.after ? [{ beforeAssetId: p.before.id, afterAssetId: p.after.id }] : []));
}

/** True when a pair has only one of its two photos. */
export function hasHalfPair(pairs: DraftPair[]): boolean {
  return pairs.some((p) => Boolean(p.before) !== Boolean(p.after));
}

export function BeforeAfterEditor({
  pairs,
  attested,
  onChange,
  disabled,
}: {
  pairs: DraftPair[];
  attested: boolean;
  onChange: (pairs: DraftPair[], attested: boolean) => void;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function upload(index: number, half: "before" | "after", e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setBusy(`${index}-${half}`);
    setError(null);
    try {
      const asset = await uploadAsset(file, "photo");
      const next = pairs.map((p, i) => (i === index ? { ...p, [half]: { id: asset.id, url: URL.createObjectURL(file) } } : p));
      onChange(next, attested);
    } catch {
      setError("Upload failed. Check your connection and try again.");
    } finally {
      setBusy(null);
    }
  }

  const slot = (index: number, half: "before" | "after") => {
    const photo = pairs[index]?.[half];
    const label = half === "before" ? "Before" : "After";
    const uploading = busy === `${index}-${half}`;
    return (
      <label
        className={`relative flex aspect-square cursor-pointer flex-col items-center justify-center overflow-hidden rounded-lg border-2 text-sm ${
          photo ? "border-amber-400" : "border-dashed border-white/20 hover:border-white/40"
        }`}
      >
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="sr-only"
          aria-label={`${label} photo, pair ${index + 1}`}
          onChange={(e) => upload(index, half, e)}
          disabled={disabled || busy !== null}
        />
        {photo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={photo.url} alt={`${label} photo, pair ${index + 1}`} className="h-full w-full object-cover" />
        ) : (
          <span className="px-2 text-center text-zinc-400">{uploading ? "Uploading…" : `Add ${label.toLowerCase()} photo`}</span>
        )}
        <span
          className={`absolute top-1 left-1 rounded-md px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide ${
            half === "after" ? "bg-amber-400 text-zinc-950" : "bg-black/75 text-white"
          }`}
        >
          {label}
        </span>
      </label>
    );
  };

  return (
    <div>
      {pairs.map((_, i) => (
        <div key={i} className="mt-4">
          <div className="mb-2 flex items-center justify-between text-sm">
            <span className="text-zinc-300">Job {i + 1}</span>
            <button
              type="button"
              className="min-h-11 px-2 text-zinc-400 underline-offset-2 hover:text-zinc-200 hover:underline"
              onClick={() => onChange(pairs.filter((__, j) => j !== i), attested)}
              disabled={disabled || busy !== null}
            >
              Remove
            </button>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:max-w-md">
            {slot(i, "before")}
            {slot(i, "after")}
          </div>
        </div>
      ))}

      {pairs.length < MAX_BEFORE_AFTER_PAIRS && (
        <button
          type="button"
          className="mt-4 inline-flex min-h-11 items-center rounded-lg border border-white/15 bg-white/5 px-4 py-2 text-sm hover:bg-white/10"
          onClick={() => onChange([...pairs, {}], attested)}
          disabled={disabled || busy !== null}
        >
          {pairs.length === 0 ? "Add a before & after" : "Add another job"}
        </button>
      )}

      {pairs.length > 0 && (
        <label className="mt-4 flex items-start gap-2 text-sm text-zinc-300">
          <input
            type="checkbox"
            className="mt-1 h-4 w-4"
            checked={attested}
            onChange={(e) => onChange(pairs, e.target.checked)}
            disabled={disabled}
          />
          <span>
            {BEFORE_AFTER_ATTESTATION} <span className="text-zinc-500">(required)</span>
          </span>
        </label>
      )}
      {error && <p className="mt-2 text-sm text-red-300">{error}</p>}
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import {
  ApiError,
  assetDownloadUrl,
  getBeforeAfter,
  setBeforeAfter,
  type BeforeAfterState,
  type Campaign,
} from "@/lib/api/browser";
import { BeforeAfterEditor, completePairs, hasHalfPair, type DraftPair } from "@/components/BeforeAfterEditor";
import { BEFORE_AFTER_ERRORS } from "@/lib/beforeAfter";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

/**
 * "Show your work: before & after" on the campaign page (api lib/beforeAfter).
 * Trades only; hidden for every other category. Changing the pairs never
 * re-renders anything by itself: they go into the next ad made for this
 * campaign and into "Make me a website".
 */
export function BeforeAfterCard({ campaign }: { campaign: Campaign }) {
  const [state, setState] = useState<BeforeAfterState | null>(null);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<DraftPair[]>([]);
  const [attested, setAttested] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getBeforeAfter(campaign.id)
      .then(setState)
      .catch(() => undefined);
  }, [campaign.id, campaign.businessCategory]);

  // Short-lived presigned thumbnails (the bucket is private).
  useEffect(() => {
    for (const p of state?.pairs ?? []) {
      for (const [id, key] of [
        [p.beforeAssetId, p.beforeKey],
        [p.afterAssetId, p.afterKey],
      ] as const) {
        if (thumbs[id]) continue;
        assetDownloadUrl(key)
          .then(({ url }) => setThumbs((t) => ({ ...t, [id]: url })))
          .catch(() => undefined);
      }
    }
  }, [state, thumbs]);

  if (!state || (!state.allowed && state.pairs.length === 0)) return null;

  function startEditing() {
    setDraft(
      (state?.pairs ?? []).map((p) => ({
        before: { id: p.beforeAssetId, url: thumbs[p.beforeAssetId] ?? "" },
        after: { id: p.afterAssetId, url: thumbs[p.afterAssetId] ?? "" },
      })),
    );
    // Already attested pairs stay attested until they change.
    setAttested(Boolean(state?.attestedAt));
    setError(null);
    setEditing(true);
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      setState(await setBeforeAfter(campaign.id, completePairs(draft), attested));
      setEditing(false);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "";
      setError(BEFORE_AFTER_ERRORS[code] ?? "Could not save. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  const ready = !hasHalfPair(draft) && (completePairs(draft).length === 0 || attested);

  return (
    <Card className="mb-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle>Before &amp; after</CardTitle>
          <CardDescription>
            {state.pairs.length > 0
              ? "Your before and after photos, shown exactly as you took them."
              : "Optional: show a job from before you started to the finished work."}{" "}
            Changes go into your next ad (Make it again, or a new ad) and into a website we make for you; the ad
            you already have doesn&apos;t change.
          </CardDescription>
        </div>
        {!editing && state.allowed && (
          <Button size="sm" variant="ghost" onClick={startEditing}>
            {state.pairs.length > 0 ? "Edit" : "Add"}
          </Button>
        )}
      </div>

      {error && <p className="mt-3 text-sm text-red-300">{error}</p>}

      {editing ? (
        <div className="mt-2">
          <BeforeAfterEditor
            pairs={draft}
            attested={attested}
            onChange={(p, a) => {
              setDraft(p);
              setAttested(a);
            }}
            disabled={busy}
          />
          <div className="mt-4 flex gap-2">
            <Button size="sm" onClick={save} disabled={busy || !ready}>
              {busy ? "Saving…" : "Save"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={busy}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        state.pairs.length > 0 && (
          <div className="mt-4 space-y-3">
            {state.pairs.map((p, i) => (
              <div key={p.beforeAssetId + p.afterAssetId} className="grid grid-cols-2 gap-3 sm:max-w-md">
                {(["before", "after"] as const).map((half) => {
                  const id = half === "before" ? p.beforeAssetId : p.afterAssetId;
                  return (
                    <div key={half} className="relative aspect-square overflow-hidden rounded-lg border border-white/10">
                      {thumbs[id] ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={thumbs[id]} alt={`${half === "before" ? "Before" : "After"}, job ${i + 1}`} className="h-full w-full object-cover" />
                      ) : (
                        <span className="flex h-full items-center justify-center text-xs text-zinc-600">…</span>
                      )}
                      <span
                        className={`absolute top-1 left-1 rounded-md px-2 py-0.5 text-[11px] font-bold uppercase ${
                          half === "after" ? "bg-amber-400 text-zinc-950" : "bg-black/75 text-white"
                        }`}
                      >
                        {half}
                      </span>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )
      )}
    </Card>
  );
}

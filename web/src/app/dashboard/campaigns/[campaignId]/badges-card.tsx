"use client";

import { useEffect, useState } from "react";
import { ApiError, getBadges, setBadges, type BadgesState, type Campaign } from "@/lib/api/browser";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { BadgePicker, EMPTY_BADGES, type BadgeDraft } from "@/components/BadgePicker";
import { BADGE_DETAIL, type BadgeViolation } from "@/lib/categories/badges";

/**
 * Badges and credentials (api lib/categories/badges): the owner ticks what is
 * true ("Licensed & insured", "ASE certified") and attests it. They go on the
 * NEXT ad made as chips on the end card; the running ad does not change.
 * The wizard asks the same (BadgePicker) so the first ad has them.
 */
export function BadgesCard({ campaign }: { campaign: Campaign }) {
  const [state, setState] = useState<BadgesState | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<BadgeDraft>(EMPTY_BADGES);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    getBadges(campaign.id)
      .then(setState)
      .catch(() => undefined);
  }, [campaign.id, campaign.businessCategory]);

  if (!state || (state.options.length === 0 && state.chips.length === 0)) return null;

  function start() {
    setDraft({ ids: state?.selection.ids ?? [], licenseNumber: state?.selection.licenseNumber ?? "", attested: false });
    setError(null);
    setDone(null);
    setEditing(true);
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await setBadges(campaign.id, {
        ids: draft.ids,
        licenseNumber: draft.ids.includes("license_number") ? draft.licenseNumber.trim() : null,
        attested: draft.attested,
      });
      setState(res);
      setEditing(false);
      setDone(
        res.chips.length === 0
          ? "Removed. Your next ad will have no badges."
          : campaign.googleCampaignResourceName
            ? "Saved. Your running ad has not changed. Your next ad will show these."
            : "Saved. Your next ad will show these.",
      );
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "";
      setError(BADGE_DETAIL[code as BadgeViolation] ?? "Not saved. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mb-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle>Badges</CardTitle>
          <CardDescription>
            {state.chips.length > 0 ? state.chips.join(" · ") : "Show customers why they can trust you. Pick only what is true."}
          </CardDescription>
        </div>
        {!editing && (
          <Button size="sm" variant="ghost" onClick={start}>
            {state.chips.length > 0 ? "Edit" : "Add badges"}
          </Button>
        )}
      </div>
      {done && <p className="mt-3 text-sm text-emerald-300">{done}</p>}

      {editing && (
        <div className="mt-4 space-y-3 text-sm">
          <BadgePicker options={state.options} value={draft} onChange={setDraft} disabled={busy} />
          {error && <p className="text-sm text-red-300">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button size="sm" disabled={busy || (draft.ids.length > 0 && !draft.attested)} onClick={save}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

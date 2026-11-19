"use client";

import { useEffect, useState } from "react";
import { ApiError, getBadges, setBadges, type BadgesState, type Campaign } from "@/lib/api/browser";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { BADGES, BADGE_ATTESTATION, BADGE_DETAIL, MAX_BADGES, type BadgeId, type BadgeViolation } from "@/lib/categories/badges";

/**
 * Badges and credentials (api lib/categories/badges): the owner ticks what is
 * true ("Licensed & insured", "ASE certified") and attests it. They go on the
 * NEXT ad made as chips on the end card; the running ad does not change.
 */
export function BadgesCard({ campaign }: { campaign: Campaign }) {
  const [state, setState] = useState<BadgesState | null>(null);
  const [editing, setEditing] = useState(false);
  const [ids, setIds] = useState<BadgeId[]>([]);
  const [license, setLicense] = useState("");
  const [attested, setAttested] = useState(false);
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
    setIds(state?.selection.ids ?? []);
    setLicense(state?.selection.licenseNumber ?? "");
    setAttested(false);
    setError(null);
    setDone(null);
    setEditing(true);
  }

  function toggle(id: BadgeId) {
    setIds((s) => (s.includes(id) ? s.filter((x) => x !== id) : s.length < MAX_BADGES ? [...s, id] : s));
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await setBadges(campaign.id, {
        ids,
        licenseNumber: ids.includes("license_number") ? license.trim() : null,
        attested,
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
          <div className="space-y-2">
            {state.options.map((id) => (
              <label key={id} className="flex items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={ids.includes(id)}
                  disabled={busy || (!ids.includes(id) && ids.length >= MAX_BADGES)}
                  onChange={() => toggle(id)}
                />
                <span>{BADGES[id].label}</span>
              </label>
            ))}
          </div>
          {ids.includes("license_number") && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-zinc-400">License number</span>
              <Input
                aria-label="License number"
                className="w-48"
                maxLength={20}
                value={license}
                onChange={(e) => setLicense(e.target.value)}
                disabled={busy}
              />
            </div>
          )}
          <p className="text-xs text-zinc-400">Up to {MAX_BADGES}. They show on the last screen of your next ad.</p>
          {ids.length > 0 && (
            <label className="flex items-start gap-2 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-200">
              <input type="checkbox" className="mt-0.5" checked={attested} onChange={(e) => setAttested(e.target.checked)} disabled={busy} />
              <span>{BADGE_ATTESTATION} I can show proof if asked.</span>
            </label>
          )}
          {error && <p className="text-sm text-red-300">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button size="sm" disabled={busy || (ids.length > 0 && !attested)} onClick={save}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

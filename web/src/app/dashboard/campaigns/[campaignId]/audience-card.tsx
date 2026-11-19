"use client";

import { useState } from "react";
import { ApiError, updateTargeting, type Campaign } from "@/lib/api/browser";
import { AudienceFiltersEditor, HOUSING_NOTICE, NARROWING_WARNING } from "@/components/AudienceFiltersEditor";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  FILTER_SECTIONS,
  HOUSING_RESTRICTED,
  filtersForSave,
  isHousingCategory,
  summarize,
  type AudienceFilters,
} from "@/lib/audience";

/**
 * "Who should see it" on the campaign page. Editable before AND after launch
 * (2026-11-20): PUT /campaigns/:id/targeting applies a launched campaign's
 * change at Google first, so the row never diverges from what is serving.
 * Success and failure are both said in plain words.
 */
export function AudienceCard({
  campaign,
  onSaved,
}: {
  campaign: Campaign;
  onSaved: (c: Campaign) => void;
}) {
  const housing = isHousingCategory(campaign.businessCategory);
  const launched = Boolean(campaign.googleCampaignResourceName);
  const [editing, setEditing] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [draft, setDraft] = useState<AudienceFilters>(campaign.audienceFilters ?? {});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const saved = campaign.audienceFilters;
  const sections = FILTER_SECTIONS.filter((s) => !(housing && HOUSING_RESTRICTED.includes(s.key)));

  async function save() {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const res = await updateTargeting(campaign.id, { audienceFilters: filtersForSave(draft, housing) });
      onSaved(res.campaign);
      setEditing(false);
      setDone(
        res.appliedAtGoogle
          ? "Saved. Google now shows your ad to this audience. It can take a few hours to settle."
          : "Saved. Your ad will use this when it launches.",
      );
    } catch (err) {
      setError(
        err instanceof ApiError && err.detail
          ? `Not changed. ${err.detail}`
          : "Not changed: we couldn't reach Google. Your ad keeps its current audience. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mb-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle>Who should see it</CardTitle>
          <CardDescription>
            {housing && campaign.targetAddress
              ? `People within ${campaign.radiusMiles} miles of ${campaign.targetAddress.street}, ${campaign.targetAddress.city}.`
              : "Everyone in your target area, unless you narrow it below."}
          </CardDescription>
        </div>
        {!editing && (
          <Button size="sm" variant="ghost" onClick={() => {
              setDone(null);
              setDraft(campaign.audienceFilters ?? {});
              setEditing(true);
            }}>
            Edit
          </Button>
        )}
      </div>

      {error && <p className="mt-3 text-sm text-red-300">{error}</p>}
      {done && <p className="mt-3 text-sm text-emerald-300">{done}</p>}

      {editing ? (
        <div className="mt-4">
          <AudienceFiltersEditor value={draft} onChange={setDraft} housing={housing} disabled={busy} />
          {launched && (
            <p className="mt-3 text-xs text-zinc-400">
              Your ad is already running, so this changes it at Google straight away.
            </p>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                setDraft(saved ?? {});
                setEditing(false);
              }}
            >
              Cancel
            </Button>
            <Button size="sm" disabled={busy} onClick={save}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      ) : (
        <>
          {housing && (
            <p className="mt-3 rounded-lg border border-sky-400/30 bg-sky-400/10 px-3 py-2 text-xs text-sky-200">
              {HOUSING_NOTICE}
            </p>
          )}
          <dl className="mt-4 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            {sections.map((s) => (
              <div key={s.key} className="flex justify-between gap-3">
                <dt className="text-zinc-500">{s.title}</dt>
                <dd className="text-right text-zinc-300">{summarize(s.key, saved)}</dd>
              </div>
            ))}
          </dl>
          {saved && (
            <p className="mt-3 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-200">
              {NARROWING_WARNING}
            </p>
          )}
        </>
      )}
    </Card>
  );
}

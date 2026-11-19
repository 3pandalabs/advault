"use client";

import { useState } from "react";
import { ApiError, updateTargeting, type Campaign } from "@/lib/api/browser";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  DAYS,
  DAY_LABEL,
  describeSchedule,
  hourLabel,
  normalizeSchedule,
  scheduleTimeZoneNote,
  type AdSchedule,
  type Day,
} from "@/lib/schedule";

const START_HOURS = Array.from({ length: 24 }, (_, i) => i);
const END_HOURS = Array.from({ length: 24 }, (_, i) => i + 1);

/**
 * "When it shows": every day all day (default), or chosen days with one time
 * window. Saved before launch; applied at Google straight away after launch
 * (PUT /campaigns/:id/targeting). Hours are in the ad account's time zone.
 */
export function ScheduleCard({ campaign, onSaved }: { campaign: Campaign; onSaved: (c: Campaign) => void }) {
  const launched = Boolean(campaign.googleCampaignResourceName);
  const saved = normalizeSchedule(campaign.adSchedule ?? null);
  const [editing, setEditing] = useState(false);
  const [mode, setMode] = useState<"always" | "pick">(saved ? "pick" : "always");
  const [draft, setDraft] = useState<AdSchedule>(saved ?? { days: ["mon", "tue", "wed", "thu", "fri"], startHour: 9, endHour: 17 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  function toggle(d: Day) {
    setDraft((s) => ({ ...s, days: s.days.includes(d) ? s.days.filter((x) => x !== d) : [...s.days, d] }));
  }

  const invalid = mode === "pick" && (draft.days.length === 0 || draft.endHour <= draft.startHour);

  async function save() {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const res = await updateTargeting(campaign.id, { adSchedule: mode === "always" ? null : draft });
      onSaved(res.campaign);
      setEditing(false);
      setDone(
        res.appliedAtGoogle
          ? "Saved. Google now shows your ad at these times."
          : "Saved. Your ad will use these times when it launches.",
      );
    } catch (err) {
      setError(
        err instanceof ApiError && err.detail
          ? `Not changed. ${err.detail}`
          : "Not changed: we couldn't reach Google. Your ad keeps its current times. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mb-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle>When it shows</CardTitle>
          <CardDescription>{describeSchedule(saved)}</CardDescription>
        </div>
        {!editing && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setDone(null);
              setMode(saved ? "pick" : "always");
              if (saved) setDraft(saved);
              setEditing(true);
            }}
          >
            Edit
          </Button>
        )}
      </div>

      {error && <p className="mt-3 text-sm text-red-300">{error}</p>}
      {done && <p className="mt-3 text-sm text-emerald-300">{done}</p>}

      {editing && (
        <div className="mt-4 space-y-3 text-sm">
          <label className="flex items-center gap-2">
            <input type="radio" checked={mode === "always"} onChange={() => setMode("always")} disabled={busy} />
            Every day, all day
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" checked={mode === "pick"} onChange={() => setMode("pick")} disabled={busy} />
            Only on some days or hours
          </label>

          {mode === "pick" && (
            <div className="space-y-3 rounded-lg border border-zinc-800 p-3">
              <div className="flex flex-wrap gap-2">
                {DAYS.map((d) => (
                  <button
                    key={d}
                    type="button"
                    disabled={busy}
                    onClick={() => toggle(d)}
                    aria-pressed={draft.days.includes(d)}
                    className={`rounded-md border px-3 py-1 ${
                      draft.days.includes(d)
                        ? "border-emerald-400 bg-emerald-400/10 text-emerald-200"
                        : "border-zinc-700 text-zinc-400"
                    }`}
                  >
                    {DAY_LABEL[d]}
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-zinc-400">From</span>
                <select
                  className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1"
                  value={draft.startHour}
                  disabled={busy}
                  onChange={(e) => setDraft((s) => ({ ...s, startHour: Number(e.target.value) }))}
                >
                  {START_HOURS.map((h) => (
                    <option key={h} value={h}>
                      {hourLabel(h)}
                    </option>
                  ))}
                </select>
                <span className="text-zinc-400">to</span>
                <select
                  className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1"
                  value={draft.endHour}
                  disabled={busy}
                  onChange={(e) => setDraft((s) => ({ ...s, endHour: Number(e.target.value) }))}
                >
                  {END_HOURS.map((h) => (
                    <option key={h} value={h}>
                      {hourLabel(h)}
                    </option>
                  ))}
                </select>
              </div>
              {draft.days.length === 0 && <p className="text-xs text-red-300">Pick at least one day.</p>}
              {draft.endHour <= draft.startHour && (
                <p className="text-xs text-red-300">The end time must be after the start time.</p>
              )}
              <p className="text-xs text-zinc-400">{scheduleTimeZoneNote(campaign.currencyCode)}</p>
              <p className="rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-200">
                Fewer hours means fewer chances to show your ad, so your ad may be shown less.
              </p>
            </div>
          )}

          {launched && (
            <p className="text-xs text-zinc-400">Your ad is already running, so this changes it at Google straight away.</p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button size="sm" disabled={busy || invalid} onClick={save}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

"use client";

import { useState } from "react";
import { ApiError, updateTargeting, type Campaign } from "@/lib/api/browser";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  DAYS,
  DAY_LABEL,
  MAX_EXTRA_WINDOWS,
  describeSchedule,
  hourLabel,
  normalizeSchedule,
  scheduleTimeZoneNote,
  scheduleWindows,
  windowsOverlap,
  type AdSchedule,
  type Day,
  type ScheduleWindow,
} from "@/lib/schedule";
import { categoryKey } from "@/lib/categories/key";
import { schedulePresets, type SchedulePreset } from "@/lib/categories/schedulePresets";

const START_HOURS = Array.from({ length: 24 }, (_, i) => i);
const END_HOURS = Array.from({ length: 24 }, (_, i) => i + 1);

function WindowEditor({
  value,
  onChange,
  onRemove,
  busy,
}: {
  value: ScheduleWindow;
  onChange: (w: ScheduleWindow) => void;
  onRemove?: () => void;
  busy: boolean;
}) {
  function toggle(d: Day) {
    onChange({ ...value, days: value.days.includes(d) ? value.days.filter((x) => x !== d) : [...value.days, d] });
  }
  return (
    <div className="space-y-3 rounded-lg border border-zinc-800 p-3">
      <div className="flex flex-wrap gap-2">
        {DAYS.map((d) => (
          <button
            key={d}
            type="button"
            disabled={busy}
            onClick={() => toggle(d)}
            aria-pressed={value.days.includes(d)}
            className={`rounded-md border px-3 py-1 ${
              value.days.includes(d) ? "border-emerald-400 bg-emerald-400/10 text-emerald-200" : "border-zinc-700 text-zinc-400"
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
          value={value.startHour}
          disabled={busy}
          onChange={(e) => onChange({ ...value, startHour: Number(e.target.value) })}
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
          value={value.endHour}
          disabled={busy}
          onChange={(e) => onChange({ ...value, endHour: Number(e.target.value) })}
        >
          {END_HOURS.map((h) => (
            <option key={h} value={h}>
              {hourLabel(h)}
            </option>
          ))}
        </select>
        {onRemove && (
          <button type="button" className="ml-auto text-xs text-zinc-400 underline" disabled={busy} onClick={onRemove}>
            Remove these times
          </button>
        )}
      </div>
      {value.days.length === 0 && <p className="text-xs text-red-300">Pick at least one day.</p>}
      {value.endHour <= value.startHour && <p className="text-xs text-red-300">The end time must be after the start time.</p>}
    </div>
  );
}

/**
 * "When it shows": every day all day (default), or chosen days with up to
 * three time windows. Trades and restaurants get one-tap suggestions
 * (lib/categories/schedulePresets). Saved before launch; applied at Google
 * straight away after launch (PUT /campaigns/:id/targeting). Hours are in the
 * ad account's time zone.
 */
export function ScheduleCard({ campaign, onSaved }: { campaign: Campaign; onSaved: (c: Campaign) => void }) {
  const launched = Boolean(campaign.googleCampaignResourceName);
  const saved = normalizeSchedule(campaign.adSchedule ?? null);
  const presets = schedulePresets(categoryKey(campaign.businessCategory));
  const [editing, setEditing] = useState(false);
  const [mode, setMode] = useState<"always" | "pick">(saved ? "pick" : "always");
  const [draft, setDraft] = useState<AdSchedule>(saved ?? { days: ["mon", "tue", "wed", "thu", "fri"], startHour: 9, endHour: 17 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const windows = scheduleWindows(draft);
  const overlap = windowsOverlap(windows);
  const invalid =
    mode === "pick" && (windows.some((w) => w.days.length === 0 || w.endHour <= w.startHour) || overlap);
  const extras = draft.extraWindows ?? [];

  function setExtra(i: number, w: ScheduleWindow | null) {
    setDraft((s) => {
      const next = [...(s.extraWindows ?? [])];
      if (w) next[i] = w;
      else next.splice(i, 1);
      return { ...s, extraWindows: next };
    });
  }

  function applyPreset(p: SchedulePreset) {
    setDone(null);
    if (p.schedule === null) setMode("always");
    else {
      setMode("pick");
      setDraft(structuredClone(p.schedule));
    }
    setEditing(true);
  }

  async function save() {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const res = await updateTargeting(campaign.id, { adSchedule: mode === "always" ? null : normalizeSchedule(draft) });
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

      {presets.length > 0 && (
        <div className="mt-3 space-y-2">
          <p className="text-xs text-zinc-400">Suggested for your business. Tap one, check it, then save.</p>
          <div className="flex flex-wrap gap-2">
            {presets.map((p) => (
              <Button key={p.id} size="sm" variant="ghost" disabled={busy} onClick={() => applyPreset(p)} title={p.hint}>
                {p.label}
              </Button>
            ))}
          </div>
        </div>
      )}

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
            <div className="space-y-3">
              <WindowEditor value={draft} onChange={(w) => setDraft((s) => ({ ...s, ...w }))} busy={busy} />
              {extras.map((w, i) => (
                <WindowEditor key={i} value={w} onChange={(n) => setExtra(i, n)} onRemove={() => setExtra(i, null)} busy={busy} />
              ))}
              {extras.length < MAX_EXTRA_WINDOWS && (
                <button
                  type="button"
                  className="text-xs text-sky-300 underline"
                  disabled={busy}
                  onClick={() => setExtra(extras.length, { days: [...draft.days], startHour: 17, endHour: 21 })}
                >
                  Add more times (for example lunch and dinner)
                </button>
              )}
              {overlap && <p className="text-xs text-red-300">Two of these times overlap on the same day. Change one.</p>}
              <p className="text-xs text-zinc-400">{scheduleTimeZoneNote(campaign.currencyCode)}</p>
              <p className="rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-200">
                Fewer hours means fewer chances to show your ad, so your ad may be shown less.
              </p>
            </div>
          )}

          {mode === "always" && presets.some((p) => p.id === "always") && (
            <p className="text-xs text-zinc-400">
              {presets.find((p) => p.id === "always")!.hint} Only say &ldquo;24/7&rdquo; in your ad if it is true.
            </p>
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

"use client";

import { useEffect, useState } from "react";
import { ApiError, getPlaceDetails, getPlacesEnabled, searchPlaces, type PlaceCandidate, type PlaceDetails } from "@/lib/api/browser";
import { Button } from "@/components/ui/button";
import { FieldHint, Input, Label } from "@/components/ui/input";

// "Find your business on Google" (optional; api routes/places.ts). The owner
// types their name and town, picks their business, and we fill in the fields
// we can. They can change everything, or skip it. Hidden entirely when the API
// has no Places key. Only the place id is saved (with the campaign).

export function usePlacesEnabled(): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let live = true;
    getPlacesEnabled()
      .then((r) => live && setEnabled(r.enabled))
      .catch(() => live && setEnabled(false));
    return () => {
      live = false;
    };
  }, []);
  return enabled;
}

export function FindOnGoogle({
  initialName = "",
  initialTown = "",
  onPick,
  picked,
  onClear,
}: {
  initialName?: string;
  initialTown?: string;
  onPick: (d: PlaceDetails) => void;
  /** The business already picked (shown with "Not this one"). */
  picked: { name: string; address: string } | null;
  onClear: () => void;
}) {
  const enabled = usePlacesEnabled();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(initialName);
  const [town, setTown] = useState(initialTown);
  const [results, setResults] = useState<PlaceCandidate[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!enabled) return null;

  if (picked) {
    return (
      <div className="rounded-lg border border-emerald-400/30 bg-emerald-400/5 p-3 text-sm">
        <p className="text-emerald-200">
          Filled in from Google: <span className="font-medium">{picked.name}</span>
        </p>
        <p className="text-xs text-zinc-400">{picked.address}</p>
        <p className="mt-1 text-xs text-zinc-400">Check the details below. You can change anything.</p>
        <button type="button" className="mt-1 text-xs text-amber-300 underline" onClick={onClear}>
          Not this one
        </button>
      </div>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full rounded-lg border border-dashed border-white/20 px-3 py-2.5 text-left text-sm text-zinc-300 hover:border-amber-400/50"
      >
        <span className="font-medium text-zinc-100">Find your business on Google</span>
        <span className="block text-xs text-zinc-500">Optional. We fill in your name, address, phone, website and hours.</span>
      </button>
    );
  }

  async function search() {
    setBusy(true);
    setError(null);
    try {
      const r = await searchPlaces(`${name.trim()} ${town.trim()}`.trim());
      setResults(r.results);
    } catch (e) {
      setError(e instanceof ApiError && e.code === "rate_limited" ? "Too many searches. Try again in a while." : "Couldn't search Google right now. You can fill the fields in yourself.");
    } finally {
      setBusy(false);
    }
  }

  async function pick(c: PlaceCandidate) {
    setBusy(true);
    setError(null);
    try {
      onPick(await getPlaceDetails(c.placeId));
      setOpen(false);
      setResults(null);
    } catch {
      setError("Couldn't load that business. Try again, or fill the fields in yourself.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-white/15 bg-white/[0.02] p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium text-zinc-100">Find your business on Google</p>
        <button type="button" className="text-xs text-zinc-400 underline" onClick={() => setOpen(false)}>
          Skip
        </button>
      </div>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <div>
          <Label htmlFor="placeName">Business name</Label>
          <Input id="placeName" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
        </div>
        <div>
          <Label htmlFor="placeTown">Town or ZIP</Label>
          <Input id="placeTown" value={town} onChange={(e) => setTown(e.target.value)} maxLength={80} />
        </div>
      </div>
      <div className="mt-2">
        <Button type="button" size="sm" onClick={search} disabled={busy || name.trim().length < 2}>
          {busy ? "Searching…" : "Search"}
        </Button>
      </div>
      {error && <p className="mt-2 text-xs text-red-300">{error}</p>}
      {results && results.length === 0 && <p className="mt-2 text-xs text-zinc-400">No match. Try another spelling, or skip this.</p>}
      {results && results.length > 0 && (
        <ul className="mt-2 space-y-1">
          {results.map((r) => (
            <li key={r.placeId}>
              <button
                type="button"
                disabled={busy}
                onClick={() => pick(r)}
                className="w-full rounded-lg border border-white/10 px-3 py-2 text-left hover:border-amber-400/50"
              >
                <span className="block text-sm text-zinc-100">{r.name}</span>
                <span className="block text-xs text-zinc-500">{r.address}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <FieldHint>From Google Maps. We only keep which business you picked.</FieldHint>
    </div>
  );
}

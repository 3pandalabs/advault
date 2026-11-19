"use client";

import { useState, useSyncExternalStore } from "react";
import { ApiError, setCampaignOffer, type Campaign } from "@/lib/api/browser";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { categoryKey, marketFor } from "@/lib/categories/key";
import { alreadyUsingSeason, seasonCard } from "@/lib/categories/seasons";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const dismissKey = (campaignId: string, seasonId: string, startsOn: string) =>
  `advault:season-dismissed:${campaignId}:${seasonId}:${startsOn}`;

function wasDismissed(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

const noopSubscribe = () => () => {};

/**
 * Seasonal calendar (api lib/categories/seasons.ts): when the category's next
 * season is near, suggest switching the offer. The owner sees and edits the
 * text before saving, and saving NEVER changes the live ad: the next ad made
 * uses it (PUT /campaigns/:id/offer).
 */
export function SeasonCard({ campaign, onSaved }: { campaign: Campaign; onSaved: (c: Campaign) => void }) {
  // Computed on the client only (today's date, and the per-browser dismiss).
  const today = useSyncExternalStore(noopSubscribe, localToday, () => null);
  const card = today
    ? seasonCard(categoryKey(campaign.businessCategory), today, {
        market: marketFor(campaign.currencyCode),
        realtyAdType: campaign.realty?.adType ?? null,
      })
    : null;
  const key = card ? dismissKey(campaign.id, card.season.id, card.startsOn) : "";
  const dismissedStored = useSyncExternalStore(noopSubscribe, () => (key ? wasDismissed(key) : false), () => false);
  const [dismissed, setDismissed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [offer, setOffer] = useState("");
  const [cta, setCta] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  if (!card) return null;
  if (!done && (dismissed || dismissedStored || alreadyUsingSeason(campaign.offerDetails, card.season))) return null;

  const launched = Boolean(campaign.googleCampaignResourceName);
  const [, m, d] = card.startsOn.split("-").map(Number);
  const when = card.status === "soon" ? `It starts ${MONTHS[m - 1]} ${d}.` : "";

  function dismiss() {
    try {
      localStorage.setItem(key, "1");
    } catch {
      /* storage blocked: hidden until the page reloads */
    }
    setDismissed(true);
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await setCampaignOffer(campaign.id, { offerDetails: offer.trim(), callToAction: cta.trim() || undefined });
      onSaved(res.campaign);
      setEditing(false);
      setDone(
        res.liveAdUnchanged
          ? "Saved. Your running ad has not changed. Your next ad will use this offer."
          : "Saved. Your next ad will use this offer.",
      );
    } catch (err) {
      setError(err instanceof ApiError && err.detail ? err.detail : "Not saved. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <Card className="mb-4">
        <CardTitle>{card.title}</CardTitle>
        <p className="mt-2 text-sm text-emerald-300">{done}</p>
      </Card>
    );
  }

  return (
    <Card className="mb-4 border-sky-400/30">
      <CardTitle>{card.title}</CardTitle>
      <CardDescription>
        {when} Switch to your {card.season.name} ad?
      </CardDescription>

      {!editing ? (
        <div className="mt-3 space-y-3">
          <p className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-200">“{card.season.offer}”</p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={dismiss}>
              Not now
            </Button>
            <Button
              size="sm"
              onClick={() => {
                setOffer(card.season.offer);
                setCta(card.season.callToAction);
                setEditing(true);
              }}
            >
              Use this offer
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-3 space-y-3 text-sm">
          <div>
            <Label htmlFor="season-offer">Your offer</Label>
            <Textarea
              id="season-offer"
              maxLength={2000}
              value={offer}
              onChange={(e) => setOffer(e.target.value)}
              className="min-h-24"
              disabled={busy}
            />
            <p className="mt-1.5 text-xs text-amber-300/90">
              This is our example. Change the prices and details so every word is true for your business.
            </p>
          </div>
          <div>
            <Label htmlFor="season-cta">Call to action</Label>
            <Input id="season-cta" maxLength={40} value={cta} onChange={(e) => setCta(e.target.value)} disabled={busy} />
          </div>
          <p className="text-xs text-zinc-400">
            {launched
              ? "Your running ad does not change. Your next ad uses this offer."
              : "Your next ad uses this offer."}
          </p>
          {error && <p className="text-sm text-red-300">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button size="sm" disabled={busy || offer.trim() === ""} onClick={save}>
              {busy ? "Saving…" : "Save offer"}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

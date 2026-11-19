"use client";

import { useState } from "react";
import { ApiError, setCampaignOffer, type Campaign } from "@/lib/api/browser";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { ClaimWarnings, hasBlockedClaim } from "@/components/ClaimWarnings";
import { PlanOfferBuilder } from "@/components/PlanOfferBuilder";

/**
 * "Your offer": the text the next ad is written from, editable in any status
 * (PUT /campaigns/:id/offer). Claim checks show as the owner types; the plan
 * offer builder (Landscaping, Cleaning, HVAC) writes the text for them.
 * Saving never changes the running ad.
 */
export function OfferCard({ campaign, onSaved }: { campaign: Campaign; onSaved: (c: Campaign) => void }) {
  const [editing, setEditing] = useState(false);
  const [offer, setOffer] = useState("");
  const [cta, setCta] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const launched = Boolean(campaign.googleCampaignResourceName);
  const blocked = hasBlockedClaim(campaign.businessCategory, offer);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await setCampaignOffer(campaign.id, { offerDetails: offer.trim(), callToAction: cta.trim() || undefined });
      onSaved(res.campaign);
      setEditing(false);
      setDone(res.liveAdUnchanged ? "Saved. Your running ad has not changed. Your next ad will use this offer." : "Saved. Your next ad will use this offer.");
    } catch (err) {
      setError(err instanceof ApiError && err.detail ? err.detail : "Not saved. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mb-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <CardTitle>Your offer</CardTitle>
          <CardDescription className="break-words">
            {campaign.offerDetails?.trim() ? `“${campaign.offerDetails.trim()}”` : "No offer yet. An ad with a price or deal gets more calls."}
          </CardDescription>
        </div>
        {!editing && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setOffer(campaign.offerDetails ?? "");
              setCta(campaign.callToAction);
              setDone(null);
              setError(null);
              setEditing(true);
            }}
          >
            Edit
          </Button>
        )}
      </div>
      {done && <p className="mt-3 text-sm text-emerald-300">{done}</p>}

      {editing && (
        <div className="mt-4 space-y-3 text-sm">
          <div>
            <Label htmlFor="offer-text">Your offer and what makes you different</Label>
            <Textarea id="offer-text" maxLength={2000} value={offer} onChange={(e) => setOffer(e.target.value)} className="min-h-24" disabled={busy} />
            <ClaimWarnings category={campaign.businessCategory} text={offer} />
            <PlanOfferBuilder category={campaign.businessCategory} currencyCode={campaign.currencyCode} onUse={setOffer} />
          </div>
          <div>
            <Label htmlFor="offer-cta">Call to action</Label>
            <Input id="offer-cta" maxLength={40} value={cta} onChange={(e) => setCta(e.target.value)} disabled={busy} />
          </div>
          <p className="text-xs text-zinc-400">
            {launched ? "Your running ad does not change. Your next ad uses this offer." : "Your next ad uses this offer."}
          </p>
          {error && <p className="text-sm text-red-300">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button size="sm" disabled={busy || offer.trim() === "" || blocked} onClick={save}>
              {busy ? "Saving…" : "Save offer"}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

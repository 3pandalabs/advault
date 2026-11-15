"use client";

import { useState } from "react";
import { ApiError, updateCampaign, type Campaign } from "@/lib/api/browser";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// "Your website" on the campaign page. A website is OPTIONAL to make ads
// (since 2026-11-15) but Google needs a link to launch (landing_url_required),
// so a campaign without one gets a clear way to add it, or to get a free site
// from SiteVault. Editable until launch, like the audience card.
const SITEVAULT_URL = "https://sitevault.3pandalabs.com";

export function WebsiteCard({ campaign, onSaved }: { campaign: Campaign; onSaved: (c: Campaign) => void }) {
  const locked = campaign.status === "live" || Boolean(campaign.googleCampaignResourceName);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(campaign.landingUrl ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const valid = draft.trim() === "" || /^https?:\/\/\S+\.\S+/i.test(draft.trim());

  async function save() {
    setBusy(true);
    setError(null);
    try {
      onSaved(await updateCampaign(campaign.id, { landingUrl: draft.trim() || null }));
      setEditing(false);
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === "campaign_is_live"
          ? "This campaign is live, so its website can't be changed here."
          : "Could not save. Check the link starts with https:// and try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mb-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <CardTitle>Your website</CardTitle>
          <CardDescription>
            {campaign.landingUrl ? (
              <a href={campaign.landingUrl} target="_blank" rel="noreferrer" className="break-all hover:underline">
                {campaign.landingUrl}
              </a>
            ) : (
              "No website yet. Your ad can still be made; Google needs a link before it goes live."
            )}
          </CardDescription>
        </div>
        {!locked && !editing && (
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
            {campaign.landingUrl ? "Edit" : "Add"}
          </Button>
        )}
      </div>

      {error && <p className="mt-3 text-sm text-red-300">{error}</p>}

      {editing && (
        <div className="mt-4 flex flex-col gap-2 sm:flex-row">
          <Input
            type="url"
            placeholder="https://mikesplumbing.com"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={busy}
            aria-label="Website link"
          />
          <div className="flex gap-2">
            <Button size="sm" onClick={save} disabled={busy || !valid}>
              {busy ? "Saving…" : "Save"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={busy}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {!campaign.landingUrl && !locked && (
        <p className="mt-3 text-sm text-zinc-300">
          Don&apos;t have a website?{" "}
          <a href={SITEVAULT_URL} target="_blank" rel="noreferrer" className="text-amber-300 underline">
            Get a free one from SiteVault
          </a>{" "}
          in a few minutes, then paste its link here.
        </p>
      )}
    </Card>
  );
}

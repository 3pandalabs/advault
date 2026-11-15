"use client";

import { useEffect, useState } from "react";
import { ApiError, createWebsite, getWebsite, updateCampaign, type Campaign } from "@/lib/api/browser";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// "Your website" on the campaign page. A website is OPTIONAL to make ads
// (since 2026-11-15) but Google needs a link to launch (landing_url_required).
// A campaign without one can paste its link, or press "Make me a website":
// AdVault builds a one-page SiteVault site from the campaign (name, category,
// offer, the ad's polished photos) plus phone and town, and uses it as the
// ad's link (POST /campaigns/:id/website). Editable until launch.

const MAKE_ERRORS: Record<string, string> = {
  website_exists: "This campaign already has a website.",
  campaign_is_live: "This campaign is live, so its website can't be changed here.",
  website_builder_not_configured: "The website builder isn't switched on yet. Please paste a link instead.",
  website_builder_failed: "We couldn't build the website just now. Please try again in a minute.",
};

export function WebsiteCard({ campaign, onSaved }: { campaign: Campaign; onSaved: (c: Campaign) => void }) {
  const locked = campaign.status === "live" || Boolean(campaign.googleCampaignResourceName);
  const [mode, setMode] = useState<"view" | "link" | "make">("view");
  const [draft, setDraft] = useState(campaign.landingUrl ?? "");
  const [phone, setPhone] = useState("");
  const [city, setCity] = useState(campaign.targetAddress?.city ?? "");
  const [hours, setHours] = useState("");
  const [attest, setAttest] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editUrl, setEditUrl] = useState<string | null>(null);

  // The SiteVault edit link is stored encrypted; fetch it only when there is one.
  useEffect(() => {
    if (!campaign.sitevaultEditEnc || editUrl) return;
    getWebsite(campaign.id)
      .then((w) => setEditUrl(w.editUrl))
      .catch(() => {});
  }, [campaign.id, campaign.sitevaultEditEnc, editUrl]);

  const linkValid = draft.trim() === "" || /^https?:\/\/\S+\.\S+/i.test(draft.trim());
  const makeValid = phone.replace(/\D/g, "").length >= 7 && city.trim().length >= 2 && attest;

  async function saveLink() {
    setBusy(true);
    setError(null);
    try {
      onSaved(await updateCampaign(campaign.id, { landingUrl: draft.trim() || null }));
      setMode("view");
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === "campaign_is_live"
          ? MAKE_ERRORS.campaign_is_live!
          : "Could not save. Check the link starts with https:// and try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function make() {
    setBusy(true);
    setError(null);
    try {
      const res = await createWebsite(campaign.id, {
        phone: phone.trim(),
        city: city.trim(),
        hours: hours.trim() || undefined,
        attest: true,
      });
      setEditUrl(res.editUrl);
      onSaved(res.campaign);
      setMode("view");
    } catch (err) {
      setError(
        err instanceof ApiError
          ? (err.code === "website_invalid" && err.detail
              ? `SiteVault says: ${err.detail}`
              : MAKE_ERRORS[err.code] ?? "Could not build the website. Please try again.")
          : "Could not build the website. Please try again.",
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
        {!locked && mode === "view" && campaign.landingUrl && (
          <Button size="sm" variant="ghost" onClick={() => setMode("link")}>
            Change
          </Button>
        )}
      </div>

      {error && <p className="mt-3 text-sm text-red-300">{error}</p>}

      {editUrl && campaign.landingUrl && mode === "view" && (
        <p className="mt-3 text-sm text-zinc-300">
          Made with SiteVault.{" "}
          <a href={editUrl} target="_blank" rel="noreferrer" className="text-amber-300 underline">
            Edit your website
          </a>{" "}
          to add services, prices, hours or more photos.
        </p>
      )}

      {!locked && !campaign.landingUrl && mode === "view" && (
        <div className="mt-4 flex flex-col gap-2 sm:flex-row">
          <Button onClick={() => setMode("make")}>Make me a website, free</Button>
          <Button variant="outline" onClick={() => setMode("link")}>
            I have a website
          </Button>
        </div>
      )}

      {mode === "link" && (
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
            <Button size="sm" onClick={saveLink} disabled={busy || !linkValid}>
              {busy ? "Saving…" : "Save"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setMode("view")} disabled={busy}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {mode === "make" && (
        <div className="mt-4 space-y-3">
          <p className="text-sm text-zinc-300">
            We&apos;ll build a one-page website from this campaign: your business name, your offer
            and your ad photos, with call and text buttons. We just need two things:
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm">
              <span className="mb-1 block text-zinc-300">Business phone</span>
              <Input
                type="tel"
                autoComplete="tel"
                placeholder="(201) 555-0100"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                disabled={busy}
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-zinc-300">Town or city</span>
              <Input placeholder="Secaucus, NJ" value={city} onChange={(e) => setCity(e.target.value)} disabled={busy} />
            </label>
          </div>
          <label className="block text-sm">
            <span className="mb-1 block text-zinc-300">Opening hours (optional)</span>
            <Input
              placeholder="Mon-Fri 8am-6pm, Sat 9am-2pm"
              value={hours}
              onChange={(e) => setHours(e.target.value)}
              disabled={busy}
            />
          </label>
          <label className="flex items-start gap-2 text-sm text-zinc-300">
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 accent-amber-400"
              checked={attest}
              onChange={(e) => setAttest(e.target.checked)}
              disabled={busy}
            />
            <span>
              I run this business, the details are accurate, and I agree to the{" "}
              <a href="https://sitevault.3pandalabs.com/terms" target="_blank" rel="noreferrer" className="underline">
                SiteVault terms
              </a>
              . The website is public.
            </span>
          </label>
          <div className="flex gap-2">
            <Button onClick={make} disabled={busy || !makeValid}>
              {busy ? "Building your website…" : "Create my website"}
            </Button>
            <Button variant="ghost" onClick={() => setMode("view")} disabled={busy}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

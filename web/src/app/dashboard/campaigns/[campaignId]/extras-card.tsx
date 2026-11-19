"use client";

import { useEffect, useState } from "react";
import {
  ApiError,
  assetDownloadUrl,
  getExtras,
  listAssets,
  setCampaignOffer,
  setExtras,
  updateCampaign,
  type Asset,
  type Campaign,
  type ExtrasState,
} from "@/lib/api/browser";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CategoryExtrasFields, NeighborPriceField } from "@/components/CategoryExtrasFields";
import { EXTRAS_DETAIL, parseZips, type CategoryExtras, type ExtrasProblem } from "@/lib/categories/extras";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Real estate: the open house stops the ad by itself; nothing to edit here. */
function RealtyNote({ campaign }: { campaign: Campaign }) {
  const r = campaign.realty;
  if (r?.adType === "listing" && r.openHouse) {
    const [, m, d] = r.openHouse.date.split("-").map(Number);
    return (
      <Card className="mb-4">
        <CardTitle>Open house ad</CardTitle>
        <CardDescription>
          Your ad stops by itself at the end of {MONTHS[m - 1]} {d}, the open house day. Nothing to do after the event.
        </CardDescription>
      </Card>
    );
  }
  return null;
}

/**
 * Category extras (api lib/categories/extras): a restaurant's featured dish and
 * order link, an auto shop's makes, a landscaper's neighbor ZIPs. Saving
 * affects the NEXT ad made; the ZIP and link buttons change the campaign
 * itself and only work before launch. The wizard asks the same
 * (CategoryExtrasFields) so the first ad has them.
 */
export function ExtrasCard({ campaign, onSaved }: { campaign: Campaign; onSaved: (c: Campaign) => void }) {
  const [state, setState] = useState<ExtrasState | null>(null);
  const [draft, setDraft] = useState<CategoryExtras>({});
  const [photos, setPhotos] = useState<Asset[]>([]);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [zipText, setZipText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const launched = Boolean(campaign.googleCampaignResourceName);

  useEffect(() => {
    getExtras(campaign.id)
      .then((s) => {
        setState(s);
        setDraft(s.extras);
        setZipText((s.extras.neighborZips ?? []).join(", "));
      })
      .catch(() => undefined);
  }, [campaign.id, campaign.businessCategory]);

  const wantsPhotos = state?.available.includes("spotlight") ?? false;
  useEffect(() => {
    if (!wantsPhotos) return;
    listAssets()
      .then((all) => setPhotos(all.filter((a) => a.kind === "photo").slice(0, 12)))
      .catch(() => undefined);
  }, [wantsPhotos]);

  useEffect(() => {
    for (const p of photos) {
      if (thumbs[p.id]) continue;
      assetDownloadUrl(p.r2Key)
        .then(({ url }) => setThumbs((t) => ({ ...t, [p.id]: url })))
        .catch(() => undefined);
    }
  }, [photos, thumbs]);

  if (!state) return null;
  if (state.available.length === 0) return <RealtyNote campaign={campaign} />;
  const has = (k: keyof CategoryExtras) => state.available.includes(k);

  async function save(next: CategoryExtras, message: string) {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const res = await setExtras(campaign.id, next);
      setState(res);
      setDraft(res.extras);
      setDone(message);
      return true;
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "";
      setError(EXTRAS_DETAIL[code as ExtrasProblem] ?? (code === "unknown_assets" ? "That photo is no longer in your library." : "Not saved. Please try again."));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const nextAd = launched ? "Saved. Your running ad has not changed. Your next ad will use this." : "Saved. Your next ad will use this.";

  async function useOrderLink() {
    if (!draft.orderUrl) return;
    setBusy(true);
    setError(null);
    try {
      onSaved(await updateCampaign(campaign.id, { landingUrl: draft.orderUrl }));
      setDone("Your ad's link is now your order page.");
    } catch {
      setError("Not changed. Check the link starts with https://.");
    } finally {
      setBusy(false);
    }
  }

  async function showInZips() {
    const zips = parseZips(zipText);
    if (!(await save({ ...draft, neighborZips: zips }, "Saved."))) return;
    setBusy(true);
    try {
      onSaved(await updateCampaign(campaign.id, { targetZipCodes: zips }));
      setDone(`Your ad will show in ${zips.length} ZIP code${zips.length === 1 ? "" : "s"} where you already work.`);
    } catch (err) {
      setError(err instanceof ApiError && err.detail ? err.detail : "Not changed. Check the ZIP codes.");
    } finally {
      setBusy(false);
    }
  }

  async function useNeighborPrice(text: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await setCampaignOffer(campaign.id, { offerDetails: text });
      onSaved(res.campaign);
      setDone(res.liveAdUnchanged ? "Offer saved. Your running ad has not changed. Your next ad will use it." : "Offer saved. Your next ad will use it.");
    } catch (err) {
      setError(err instanceof ApiError && err.detail ? err.detail : "Not saved. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mb-4">
      <CategoryExtrasFields
        available={state.available}
        value={draft}
        onChange={setDraft}
        photos={photos.map((p) => ({ id: p.id, url: thumbs[p.id], label: p.originalFilename ?? undefined }))}
        zipText={zipText}
        onZipText={setZipText}
        orderUrlAction={
          draft.orderUrl && draft.orderUrl === state.extras.orderUrl && draft.orderUrl !== campaign.landingUrl && !launched ? (
            <Button size="sm" variant="ghost" disabled={busy} onClick={useOrderLink}>
              Send people from my ad to this link
            </Button>
          ) : null
        }
        zipsAction={
          <>
            {launched ? (
              <p className="text-xs text-zinc-400">Your ad is already running, so its ZIP codes can&apos;t change. Use these for your next campaign.</p>
            ) : (
              <Button size="sm" variant="ghost" disabled={busy || parseZips(zipText).length === 0} onClick={showInZips}>
                Show my ad in these ZIP codes
              </Button>
            )}
            <NeighborPriceField onUse={useNeighborPrice} disabled={busy} />
          </>
        }
      />

      {error && <p className="mt-3 text-sm text-red-300">{error}</p>}
      {done && <p className="mt-3 text-sm text-emerald-300">{done}</p>}
      {(has("spotlight") || has("orderUrl") || has("makes")) && (
        <div className="mt-4 flex justify-end">
          <Button size="sm" disabled={busy} onClick={() => save(draft, nextAd)}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </div>
      )}
    </Card>
  );
}

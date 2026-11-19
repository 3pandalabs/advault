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
import { Input, Label, Textarea } from "@/components/ui/input";
import {
  COMMON_MAKES,
  EXTRAS_DETAIL,
  MAX_MAKES,
  neighborOfferText,
  parseZips,
  type CategoryExtras,
  type ExtrasProblem,
} from "@/lib/categories/extras";

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
 * itself and only work before launch.
 */
export function ExtrasCard({ campaign, onSaved }: { campaign: Campaign; onSaved: (c: Campaign) => void }) {
  const [state, setState] = useState<ExtrasState | null>(null);
  const [draft, setDraft] = useState<CategoryExtras>({});
  const [photos, setPhotos] = useState<Asset[]>([]);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [zipText, setZipText] = useState("");
  const [makeText, setMakeText] = useState("");
  const [deal, setDeal] = useState("");
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

  async function useNeighborPrice() {
    const text = neighborOfferText(deal);
    if (!text) return;
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

  const makes = draft.makes ?? [];
  function toggleMake(m: string) {
    setDraft((d) => {
      const cur = d.makes ?? [];
      return { ...d, makes: cur.includes(m) ? cur.filter((x) => x !== m) : cur.length < MAX_MAKES ? [...cur, m] : cur };
    });
  }

  return (
    <Card className="mb-4">
      {has("spotlight") && (
        <div className="space-y-3 text-sm">
          <div>
            <CardTitle>Feature one dish</CardTitle>
            <CardDescription>Your best dish, its photo and price lead your next ad.</CardDescription>
          </div>
          <div className="grid gap-2 sm:grid-cols-3">
            <div className="sm:col-span-2">
              <Label htmlFor="dish">Dish</Label>
              <Input
                id="dish"
                maxLength={40}
                placeholder="Wood-fired Margherita"
                value={draft.spotlight?.dish ?? ""}
                onChange={(e) => setDraft((d) => ({ ...d, spotlight: { ...d.spotlight, dish: e.target.value } }))}
              />
            </div>
            <div>
              <Label htmlFor="dish-price">Price (optional)</Label>
              <Input
                id="dish-price"
                maxLength={12}
                placeholder="$14"
                value={draft.spotlight?.price ?? ""}
                onChange={(e) => setDraft((d) => ({ ...d, spotlight: { dish: d.spotlight?.dish ?? "", ...d.spotlight, price: e.target.value } }))}
              />
            </div>
          </div>
          {photos.length > 0 && (
            <div>
              <p className="mb-1.5 text-zinc-400">Its photo</p>
              <div className="flex flex-wrap gap-2">
                {photos.map((p) => {
                  const picked = draft.spotlight?.assetId === p.id;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      aria-pressed={picked}
                      aria-label={p.originalFilename ?? "Photo"}
                      onClick={() =>
                        setDraft((d) => ({ ...d, spotlight: { dish: d.spotlight?.dish ?? "", ...d.spotlight, assetId: picked ? null : p.id } }))
                      }
                      className={`h-16 w-16 overflow-hidden rounded-md border-2 ${picked ? "border-amber-400" : "border-transparent"}`}
                    >
                      {thumbs[p.id] ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={thumbs[p.id]} alt="" className="h-full w-full object-cover" />
                      ) : (
                        <span className="block h-full w-full bg-zinc-800" />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {has("orderUrl") && (
        <div className="mt-4 space-y-2 text-sm">
          <Label htmlFor="order-url">Order or reserve link (optional)</Label>
          <Input
            id="order-url"
            type="url"
            maxLength={500}
            placeholder="https://order.example.com/your-restaurant"
            value={draft.orderUrl ?? ""}
            onChange={(e) => setDraft((d) => ({ ...d, orderUrl: e.target.value }))}
          />
          {draft.orderUrl && draft.orderUrl === state.extras.orderUrl && draft.orderUrl !== campaign.landingUrl && !launched && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={useOrderLink}>
              Send people from my ad to this link
            </Button>
          )}
        </div>
      )}

      {has("makes") && (
        <div className="space-y-3 text-sm">
          <div>
            <CardTitle>Makes you service</CardTitle>
            <CardDescription>Shown on your next ad, for example &ldquo;We service Toyota · Honda · Ford&rdquo;.</CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            {[...new Set([...COMMON_MAKES, ...makes])].map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={makes.includes(m)}
                onClick={() => toggleMake(m)}
                className={`rounded-md border px-3 py-1 ${makes.includes(m) ? "border-emerald-400 bg-emerald-400/10 text-emerald-200" : "border-zinc-700 text-zinc-400"}`}
              >
                {m}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Input aria-label="Another make" className="w-44" maxLength={20} placeholder="Another make" value={makeText} onChange={(e) => setMakeText(e.target.value)} />
            <Button
              size="sm"
              variant="ghost"
              disabled={!makeText.trim()}
              onClick={() => {
                toggleMake(makeText.trim());
                setMakeText("");
              }}
            >
              Add
            </Button>
          </div>
          <p className="text-xs text-zinc-400">Up to {MAX_MAKES}. Pick only makes you really work on.</p>
        </div>
      )}

      {has("neighborZips") && (
        <div className="space-y-3 text-sm">
          <div>
            <CardTitle>Show your ad where you already work</CardTitle>
            <CardDescription>
              Type the ZIP codes of your current customers. Neighbors see your trucks every week, so they trust you faster.
            </CardDescription>
          </div>
          <Textarea aria-label="ZIP codes of your customers" className="min-h-16" placeholder="08817, 08820, 08837" value={zipText} onChange={(e) => setZipText(e.target.value)} />
          {launched ? (
            <p className="text-xs text-zinc-400">Your ad is already running, so its ZIP codes can&apos;t change. Use these for your next campaign.</p>
          ) : (
            <Button size="sm" variant="ghost" disabled={busy || parseZips(zipText).length === 0} onClick={showInZips}>
              Show my ad in these ZIP codes
            </Button>
          )}
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <Label htmlFor="neighbor-deal">Neighbor price (optional)</Label>
              <Input id="neighbor-deal" className="w-56" maxLength={40} placeholder="$10 off your first mow" value={deal} onChange={(e) => setDeal(e.target.value)} />
            </div>
            <Button size="sm" variant="ghost" disabled={busy || !neighborOfferText(deal)} onClick={useNeighborPrice}>
              Use as my offer
            </Button>
          </div>
          {neighborOfferText(deal) && <p className="text-xs text-zinc-400">“{neighborOfferText(deal)}”</p>}
        </div>
      )}

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

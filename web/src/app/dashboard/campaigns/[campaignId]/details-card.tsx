"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ApiError, deleteCampaign, updateCampaign, type Campaign, type Realty } from "@/lib/api/browser";
import { HOUSING_NOTICE } from "@/components/AudienceFiltersEditor";
import { CATEGORIES, isHousingCategory } from "@/lib/audience";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { FieldHint, Input, Label, Textarea } from "@/components/ui/input";

const PRESETS: readonly string[] = CATEGORIES;
const ERRORS: Record<string, string> = {
  category_locked: "The category can't change now: an ad was already made or paid for with it. Make a new campaign instead.",
  campaign_already_launched: "This ad was already sent to Google, so its category and area can't change here.",
  campaign_is_live: "This ad is running. Pause it first.",
  campaign_rendering: "We're making a video for this campaign. Try again when it's done.",
  campaign_has_payment: "You paid for something on this campaign, so it can't be deleted. Contact us and we'll help.",
};
const message = (err: unknown, fallback: string) =>
  err instanceof ApiError ? (ERRORS[err.code] ?? err.detail ?? fallback) : fallback;

function initial(c: Campaign) {
  const preset = PRESETS.includes(c.businessCategory) && c.businessCategory !== "Other";
  const r = c.realty;
  return {
    name: c.name,
    businessName: c.businessName,
    choice: preset ? c.businessCategory : "Other",
    custom: preset ? "" : c.businessCategory,
    zips: c.targetZipCodes.join(", "),
    radius: String(c.radiusMiles),
    street: c.targetAddress?.street ?? "",
    city: c.targetAddress?.city ?? "",
    state: c.targetAddress?.state ?? "",
    zip: c.targetAddress?.postalCode ?? "",
    adType: (r?.adType ?? "agent") as Realty["adType"],
    price: r?.price ?? "",
    beds: r?.beds != null ? String(r.beds) : "",
    baths: r?.baths != null ? String(r.baths) : "",
    ohDate: r?.openHouse?.date ?? "",
    ohStart: r?.openHouse?.start ?? "",
    ohEnd: r?.openHouse?.end ?? "",
  };
}

/**
 * "Campaign details" before launch: name, business, category and area, and
 * Delete. The category is fixed once an ad was made or paid for. The API
 * enforces all of it (PATCH and DELETE /campaigns/:id). The offer and the
 * website have their own cards.
 */
export function DetailsCard({
  campaign,
  locked,
  onSaved,
}: {
  campaign: Campaign;
  locked: boolean;
  onSaved: (c: Campaign) => void;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [f, setF] = useState(() => initial(campaign));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const set =
    (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
      setF((x) => ({ ...x, [k]: e.target.value }));

  const category = locked ? campaign.businessCategory : f.choice === "Other" ? f.custom.trim() : f.choice;
  const housing = isHousingCategory(category);
  const crossing = housing !== isHousingCategory(campaign.businessCategory);
  const isHome = f.adType !== "agent";
  const zips = f.zips.split(/[\s,]+/).filter(Boolean);
  const zipsOk =
    zips.length > 0 &&
    zips.length <= 50 &&
    zips.every((z) => /^\d{5}$|^\d{6}$/.test(z)) &&
    new Set(zips.map((z) => z.length)).size === 1;
  const addressOk =
    f.street.trim() !== "" &&
    f.city.trim() !== "" &&
    /^[A-Za-z]{2}$/.test(f.state.trim()) &&
    /^\d{5}$/.test(f.zip.trim());
  const ohAny = f.ohDate !== "" || f.ohStart !== "" || f.ohEnd !== "";
  const ohOk = !ohAny || (f.ohDate !== "" && f.ohStart !== "" && f.ohEnd > f.ohStart);
  const factsOk =
    !isHome ||
    ((f.adType === "sold" || ohOk) &&
      (f.beds.trim() === "" || /^\d{1,2}$/.test(f.beds.trim())) &&
      (f.baths.trim() === "" || /^\d{1,2}(\.5)?$/.test(f.baths.trim())));
  const radius = Number(f.radius);
  const problem =
    !f.name.trim() || !f.businessName.trim() || !category
      ? "Fill in the campaign name, business name and category."
      : !Number.isInteger(radius) || radius < 1 || radius > 50
        ? "The radius is a whole number from 1 to 50."
        : housing && !addressOk
          ? "Enter the full address: street, city, 2-letter state and ZIP."
          : housing && !locked && !factsOk
            ? "Check the bedrooms, bathrooms and open house times."
            : !housing && !zipsOk
              ? "Enter up to 50 ZIP codes (5 digits), separated by commas."
              : null;

  async function save() {
    setBusy(true);
    setError(null);
    const realty: Realty = isHome
      ? {
          adType: f.adType,
          price: f.price.trim() || null,
          beds: f.beds.trim() ? Number(f.beds) : null,
          baths: f.baths.trim() ? Number(f.baths) : null,
          openHouse: f.adType === "listing" && ohAny ? { date: f.ohDate, start: f.ohStart, end: f.ohEnd } : null,
        }
      : { adType: "agent" };
    try {
      const saved = await updateCampaign(campaign.id, {
        name: f.name.trim(),
        radiusMiles: radius,
        ...(locked ? {} : { businessName: f.businessName.trim(), businessCategory: category }),
        ...(housing
          ? {
              targetZipCodes: [],
              targetAddress: {
                street: f.street.trim(),
                city: f.city.trim(),
                state: f.state.trim().toUpperCase(),
                postalCode: f.zip.trim(),
              },
              ...(locked ? {} : { realty }),
            }
          : { targetZipCodes: zips }),
      });
      onSaved(saved);
      setEditing(false);
      setDone(true);
    } catch (err) {
      setError(message(err, "Not saved. Please try again."));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await deleteCampaign(campaign.id);
      router.push("/dashboard");
    } catch (err) {
      setError(message(err, "Not deleted. Please try again."));
      setBusy(false);
      setConfirmDelete(false);
    }
  }

  const select =
    "h-10 w-full rounded-lg border border-white/15 bg-white/5 px-3 text-sm text-zinc-100 focus:border-amber-400/60 focus:outline-none focus:ring-1 focus:ring-amber-400/60";

  return (
    <Card className="mb-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <CardTitle>Campaign details</CardTitle>
          <CardDescription className="break-words">
            {campaign.businessName} &middot; {campaign.businessCategory}
          </CardDescription>
        </div>
        {!editing && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setF(initial(campaign));
              setError(null);
              setDone(false);
              setConfirmDelete(false);
              setEditing(true);
            }}
          >
            Edit
          </Button>
        )}
      </div>
      {done && !editing && <p className="mt-2 text-sm text-emerald-300">Saved.</p>}

      {editing && (
        <div className="mt-4 space-y-4">
          <div>
            <Label htmlFor="d-name">Campaign name</Label>
            <Input id="d-name" maxLength={120} value={f.name} onChange={set("name")} />
          </div>
          {locked ? (
            <FieldHint>
              The business name and category can&apos;t change: an ad was already made or paid for with them.
            </FieldHint>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="d-business">Business name</Label>
                <Input id="d-business" maxLength={160} value={f.businessName} onChange={set("businessName")} />
              </div>
              <div>
                <Label htmlFor="d-category">Category</Label>
                <select id="d-category" value={f.choice} onChange={set("choice")} className={select}>
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c} className="bg-zinc-900">
                      {c === "Real estate" ? "Real estate (agent, listings, open house)" : c}
                    </option>
                  ))}
                </select>
                {f.choice === "Other" && (
                  <Input
                    aria-label="Your category"
                    className="mt-2"
                    maxLength={80}
                    value={f.custom}
                    onChange={set("custom")}
                    placeholder="Pet grooming"
                  />
                )}
              </div>
            </div>
          )}
          {category !== campaign.businessCategory && (
            <p className="rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-100">
              Changing the category removes badges, extras and before &amp; after photos added for the old one.
              {crossing ? " The old area and audience choices are removed too: enter the new area below." : ""}
            </p>
          )}

          {housing ? (
            <>
              <p className="rounded-lg border border-sky-400/30 bg-sky-400/10 px-3 py-2 text-xs text-sky-200">
                {HOUSING_NOTICE}
              </p>
              {!locked && (
                <div>
                  <Label htmlFor="d-adtype">What is this ad for?</Label>
                  <select id="d-adtype" value={f.adType} onChange={set("adType")} className={select}>
                    <option value="agent" className="bg-zinc-900">
                      Me, as an agent
                    </option>
                    <option value="listing" className="bg-zinc-900">
                      A listing or open house
                    </option>
                    <option value="sold" className="bg-zinc-900">
                      Just sold
                    </option>
                  </select>
                </div>
              )}
              <div>
                <Label htmlFor="d-street">
                  {isHome ? "Address of the home" : "Office address, or the center of the area you serve"}
                </Label>
                <div className="grid gap-2 sm:grid-cols-6">
                  <Input
                    id="d-street"
                    className="sm:col-span-6"
                    placeholder="123 Main St"
                    maxLength={200}
                    value={f.street}
                    onChange={set("street")}
                  />
                  <Input
                    aria-label="City"
                    className="sm:col-span-3"
                    placeholder="City"
                    maxLength={100}
                    value={f.city}
                    onChange={set("city")}
                  />
                  <Input
                    aria-label="State"
                    className="sm:col-span-1"
                    placeholder="TX"
                    maxLength={2}
                    value={f.state}
                    onChange={set("state")}
                  />
                  <Input
                    aria-label="ZIP"
                    className="sm:col-span-2"
                    placeholder="78701"
                    inputMode="numeric"
                    maxLength={5}
                    value={f.zip}
                    onChange={set("zip")}
                  />
                </div>
              </div>
              {isHome && !locked && (
                <div className="grid gap-2 sm:grid-cols-3">
                  <div>
                    <Label htmlFor="d-price">Price</Label>
                    <Input id="d-price" placeholder="$489,000" maxLength={20} value={f.price} onChange={set("price")} />
                  </div>
                  <div>
                    <Label htmlFor="d-beds">Bedrooms</Label>
                    <Input id="d-beds" inputMode="numeric" maxLength={2} value={f.beds} onChange={set("beds")} />
                  </div>
                  <div>
                    <Label htmlFor="d-baths">Bathrooms</Label>
                    <Input id="d-baths" inputMode="decimal" maxLength={4} value={f.baths} onChange={set("baths")} />
                  </div>
                  {f.adType === "listing" && (
                    <div className="sm:col-span-3">
                      <Label htmlFor="d-ohdate">Open house (optional)</Label>
                      <div className="grid gap-2 sm:grid-cols-3">
                        <Input id="d-ohdate" type="date" value={f.ohDate} onChange={set("ohDate")} />
                        <Input type="time" aria-label="Starts" value={f.ohStart} onChange={set("ohStart")} />
                        <Input type="time" aria-label="Ends" value={f.ohEnd} onChange={set("ohEnd")} />
                      </div>
                      <FieldHint>With an open house, your ad stops by itself at the end of that day.</FieldHint>
                    </div>
                  )}
                </div>
              )}
            </>
          ) : (
            <div>
              <Label htmlFor="d-zips">Target ZIP or PIN codes</Label>
              <Textarea
                id="d-zips"
                className="min-h-20"
                value={f.zips}
                onChange={set("zips")}
                placeholder="94110, 94103"
              />
            </div>
          )}
          <div>
            <Label htmlFor="d-radius">Radius (miles)</Label>
            <Input id="d-radius" type="number" min={1} max={50} value={f.radius} onChange={set("radius")} />
          </div>

          {problem && <p className="text-xs text-amber-300/90">{problem}</p>}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={save} disabled={busy || problem !== null}>
              {busy ? "Saving…" : "Save"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={busy}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {!editing && (
        <div className="mt-3 text-sm">
          {confirmDelete ? (
            <div className="rounded-lg border border-red-400/30 bg-red-400/10 p-3">
              <p className="break-words text-red-200">
                Delete &ldquo;{campaign.name}&rdquo; and its videos? This can&apos;t be undone.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={remove} disabled={busy}>
                  {busy ? "Deleting…" : "Delete campaign"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)} disabled={busy}>
                  Keep it
                </Button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => {
                setError(null);
                setConfirmDelete(true);
              }}
              className="text-xs text-zinc-400 underline hover:text-red-300"
            >
              Delete this campaign
            </button>
          )}
        </div>
      )}
      {error && <p className="mt-3 text-sm text-red-300">{error}</p>}
    </Card>
  );
}

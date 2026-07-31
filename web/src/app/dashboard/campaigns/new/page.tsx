"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  ApiError,
  assetDownloadUrl,
  createCampaign,
  generateCreatives,
  getMe,
  listAssets,
  uploadAsset,
  type Asset,
} from "@/lib/api/browser";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { FieldHint, Input, Label, Textarea } from "@/components/ui/input";
import { parseDollarsToCents } from "@/lib/utils";

// The three-step wizard. Steps are local state rather than routes: the whole
// flow is one create-then-generate transaction, and a per-step URL would let a
// browser back button land on step 3 of a campaign that was never created.
//
// Nothing chargeable happens here. The campaign is created as a draft and the
// creatives render for free; spending is a separate, explicit action on the
// campaign page.

const ASPECT_OPTIONS = [
  { value: "16:9" as const, label: "16:9 pre-roll", hint: "Plays before YouTube videos" },
  { value: "9:16" as const, label: "9:16 Shorts", hint: "Vertical, for the Shorts feed" },
];

const MAX_PHOTOS = 5;

export default function NewCampaignPage() {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Step 1 — assets
  const [assets, setAssets] = useState<Asset[]>([]);
  const [selectedAssetIds, setSelectedAssetIds] = useState<string[]>([]);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [uploading, setUploading] = useState(false);

  // Step 2 — targeting
  const [form, setForm] = useState({
    name: "",
    businessName: "",
    businessCategory: "",
    callToAction: "Call now",
    landingUrl: "",
    offerDetails: "",
    zipInput: "",
    radiusMiles: "10",
    dailyBudget: "15",
  });

  // Step 3 — formats
  const [aspectRatios, setAspectRatios] = useState<("16:9" | "9:16")[]>(["16:9", "9:16"]);

  useEffect(() => {
    // Prefill from the profile so an advertiser who filled this in at signup
    // does not type it again.
    getMe()
      .then((me) =>
        setForm((f) => ({
          ...f,
          businessName: f.businessName || (me.businessName ?? ""),
          businessCategory: f.businessCategory || (me.businessCategory ?? ""),
          name: f.name || (me.businessName ? `${me.businessName} — local reach` : ""),
        })),
      )
      .catch(() => undefined);

    listAssets().then(setAssets).catch(() => undefined);
  }, []);

  // Thumbnails are short-lived presigned URLs fetched one per asset. Kept in
  // state rather than rendered straight from the key because the key is not a
  // URL — the bucket is private and has no public domain attached, by design.
  useEffect(() => {
    for (const asset of assets) {
      if (thumbs[asset.id]) continue;
      assetDownloadUrl(asset.r2Key)
        .then(({ url }) => setThumbs((t) => ({ ...t, [asset.id]: url })))
        .catch(() => undefined);
    }
  }, [assets, thumbs]);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const zipCodes = form.zipInput
    .split(/[\s,]+/)
    .map((z) => z.trim())
    .filter(Boolean);
  const invalidZips = zipCodes.filter((z) => !/^\d{5}$/.test(z));

  async function onUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;
    setUploading(true);
    setError(null);
    try {
      for (const file of files) {
        const asset = await uploadAsset(file, "photo");
        setAssets((a) => [asset, ...a]);
        setSelectedAssetIds((s) => (s.length < MAX_PHOTOS ? [...s, asset.id] : s));
      }
    } catch {
      // Almost always one of two things, and both are invisible from the API
      // side — the browser's preflight failing because the bucket has no CORS
      // policy, or R2 rejecting a checksum baked into the presigned URL. Both
      // are covered in infra/r2-setup.md.
      setError("Upload failed. Check your connection and try again.");
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  }

  function toggleAsset(id: string) {
    setSelectedAssetIds((s) =>
      s.includes(id) ? s.filter((x) => x !== id) : s.length < MAX_PHOTOS ? [...s, id] : s,
    );
  }

  async function onFinish() {
    setBusy(true);
    setError(null);

    const dailyBudgetCents = parseDollarsToCents(form.dailyBudget);
    if (!dailyBudgetCents) {
      setError("Enter a daily budget as a number, for example 15.");
      setBusy(false);
      return;
    }

    try {
      const campaign = await createCampaign({
        name: form.name.trim(),
        businessName: form.businessName.trim(),
        businessCategory: form.businessCategory.trim(),
        callToAction: form.callToAction.trim(),
        landingUrl: form.landingUrl.trim(),
        offerDetails: form.offerDetails.trim() || null,
        targetZipCodes: zipCodes,
        radiusMiles: Number(form.radiusMiles),
        dailyBudgetCents,
      });

      // 202 — the API writes the scripts and queues the renders, then returns.
      // Encoding takes ~30s per creative, so the campaign page polls rather
      // than this request blocking on ffmpeg.
      await generateCreatives(campaign.id, { assetIds: selectedAssetIds, aspectRatios });
      router.push(`/dashboard/campaigns/${campaign.id}`);
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === "invalid_request"
          ? "Some details were rejected. Check the budget, landing URL and ZIP codes."
          : "Could not create the campaign. Please try again.",
      );
      setBusy(false);
    }
  }

  const canAdvanceFrom1 = selectedAssetIds.length >= 1;
  const canAdvanceFrom2 =
    form.name.trim() &&
    form.businessName.trim() &&
    form.businessCategory.trim() &&
    /^https?:\/\//i.test(form.landingUrl.trim()) &&
    zipCodes.length > 0 &&
    invalidZips.length === 0 &&
    parseDollarsToCents(form.dailyBudget) !== null;

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">New campaign</h1>

      <ol className="mt-6 mb-8 flex items-center gap-2 text-sm">
        {["Photos", "Where & how much", "Formats"].map((label, i) => (
          <li key={label} className="flex items-center gap-2">
            <span
              className={
                step === i + 1
                  ? "rounded-full bg-amber-400 px-3 py-1 font-medium text-zinc-950"
                  : step > i + 1
                    ? "rounded-full bg-white/10 px-3 py-1 text-zinc-300"
                    : "rounded-full border border-white/10 px-3 py-1 text-zinc-500"
              }
            >
              {i + 1}. {label}
            </span>
            {i < 2 && <span className="text-zinc-700">—</span>}
          </li>
        ))}
      </ol>

      {error && (
        <p className="mb-4 rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2 text-sm text-red-200">
          {error}
        </p>
      )}

      {step === 1 && (
        <Card>
          <CardTitle>Add photos of your business</CardTitle>
          <CardDescription>
            Three to five works best — your storefront, your van, your finished work. These
            become the scenes in your ad, so pick shots you would show a customer.
          </CardDescription>

          <div className="mt-5">
            <label className="inline-flex cursor-pointer items-center rounded-lg border border-white/15 bg-white/5 px-4 py-2 text-sm hover:bg-white/10">
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                multiple
                className="hidden"
                onChange={onUpload}
                disabled={uploading}
              />
              {uploading ? "Uploading…" : "Choose photos"}
            </label>
            {/* AVIF is deliberately absent from the accept list: the renderer's
                alpine ffmpeg has no AVIF decoder, so it would upload cleanly
                and then fail at encode time. */}
            <FieldHint>JPEG, PNG or WebP. Up to {MAX_PHOTOS} photos per ad.</FieldHint>
          </div>

          {assets.length > 0 && (
            <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {assets.map((asset) => {
                const index = selectedAssetIds.indexOf(asset.id);
                return (
                  <button
                    key={asset.id}
                    type="button"
                    onClick={() => toggleAsset(asset.id)}
                    className={`relative aspect-square overflow-hidden rounded-lg border-2 transition-colors ${
                      index >= 0 ? "border-amber-400" : "border-white/10 hover:border-white/25"
                    }`}
                  >
                    {thumbs[asset.id] ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={thumbs[asset.id]}
                        alt={asset.originalFilename ?? "Uploaded photo"}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <span className="flex h-full items-center justify-center text-xs text-zinc-600">
                        …
                      </span>
                    )}
                    {index >= 0 && (
                      <span className="absolute top-1 left-1 flex h-6 w-6 items-center justify-center rounded-full bg-amber-400 text-xs font-semibold text-zinc-950">
                        {index + 1}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}

          <p className="mt-4 text-xs text-zinc-500">
            Selected photos play in the order you picked them.
          </p>

          <div className="mt-6 flex justify-end">
            <Button onClick={() => setStep(2)} disabled={!canAdvanceFrom1}>
              Continue
            </Button>
          </div>
        </Card>
      )}

      {step === 2 && (
        <Card>
          <CardTitle>Where should this run, and for how much?</CardTitle>
          <CardDescription>
            Only people in these areas will see the ad, so none of your budget reaches anyone
            who cannot become a customer.
          </CardDescription>

          <div className="mt-5 space-y-4">
            <div>
              <Label htmlFor="name">Campaign name</Label>
              <Input id="name" value={form.name} onChange={set("name")} required />
              <FieldHint>Only you see this.</FieldHint>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="businessName">Business name</Label>
                <Input id="businessName" value={form.businessName} onChange={set("businessName")} />
              </div>
              <div>
                <Label htmlFor="businessCategory">Category</Label>
                <Input
                  id="businessCategory"
                  value={form.businessCategory}
                  onChange={set("businessCategory")}
                  placeholder="Plumbing"
                />
              </div>
            </div>

            <div>
              <Label htmlFor="zipInput">Target ZIP codes</Label>
              <Textarea
                id="zipInput"
                value={form.zipInput}
                onChange={set("zipInput")}
                placeholder="94110, 94103, 94107"
                className="min-h-20"
              />
              {invalidZips.length > 0 ? (
                <p className="mt-1.5 text-xs text-red-300">
                  Not a 5-digit ZIP code: {invalidZips.join(", ")}
                </p>
              ) : (
                <FieldHint>
                  {zipCodes.length > 0
                    ? `${zipCodes.length} ZIP code${zipCodes.length === 1 ? "" : "s"}`
                    : "Separate with commas or spaces."}
                </FieldHint>
              )}
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="radiusMiles">Radius (miles)</Label>
                <Input
                  id="radiusMiles"
                  type="number"
                  min={1}
                  max={50}
                  value={form.radiusMiles}
                  onChange={set("radiusMiles")}
                />
                <FieldHint>How far around those ZIPs to reach. Max 50.</FieldHint>
              </div>
              <div>
                <Label htmlFor="dailyBudget">Daily budget (USD)</Label>
                <Input
                  id="dailyBudget"
                  inputMode="decimal"
                  value={form.dailyBudget}
                  onChange={set("dailyBudget")}
                />
                <FieldHint>Google never charges more than this per day.</FieldHint>
              </div>
            </div>

            <div>
              <Label htmlFor="landingUrl">Where should viewers go?</Label>
              <Input
                id="landingUrl"
                type="url"
                placeholder="https://mikesplumbing.com"
                value={form.landingUrl}
                onChange={set("landingUrl")}
              />
            </div>

            <div>
              <Label htmlFor="callToAction">Call to action</Label>
              <Input
                id="callToAction"
                maxLength={40}
                value={form.callToAction}
                onChange={set("callToAction")}
              />
            </div>

            <div>
              <Label htmlFor="offerDetails">Anything else worth saying? (optional)</Label>
              <Textarea
                id="offerDetails"
                maxLength={2000}
                value={form.offerDetails}
                onChange={set("offerDetails")}
                placeholder="Family-run since 1998. Same-day emergency callouts."
              />
              <FieldHint>
                Used to write the script. Only include things that are true — your ad is a public
                statement about your business.
              </FieldHint>
            </div>
          </div>

          <div className="mt-6 flex justify-between">
            <Button variant="ghost" onClick={() => setStep(1)}>
              Back
            </Button>
            <Button onClick={() => setStep(3)} disabled={!canAdvanceFrom2}>
              Continue
            </Button>
          </div>
        </Card>
      )}

      {step === 3 && (
        <Card>
          <CardTitle>Which formats?</CardTitle>
          <CardDescription>
            Most local businesses run both. They are written separately — a vertical Shorts
            caption has far less room than the same words in a 16:9 pre-roll.
          </CardDescription>

          <div className="mt-5 space-y-3">
            {ASPECT_OPTIONS.map((opt) => (
              <label
                key={opt.value}
                className="flex cursor-pointer items-start gap-3 rounded-lg border border-white/10 bg-white/[0.02] p-3 hover:bg-white/[0.05]"
              >
                <input
                  type="checkbox"
                  className="mt-1 accent-amber-400"
                  checked={aspectRatios.includes(opt.value)}
                  onChange={(e) =>
                    setAspectRatios((r) =>
                      e.target.checked ? [...r, opt.value] : r.filter((x) => x !== opt.value),
                    )
                  }
                />
                <span>
                  <span className="block text-sm font-medium text-zinc-100">{opt.label}</span>
                  <span className="block text-xs text-zinc-500">{opt.hint}</span>
                </span>
              </label>
            ))}
          </div>

          <p className="mt-5 text-sm text-zinc-400">
            We will write the script and render your videos. Nothing is charged and no ad runs
            until you connect Google Ads and launch — and even then the campaign is created
            paused.
          </p>

          <div className="mt-6 flex justify-between">
            <Button variant="ghost" onClick={() => setStep(2)}>
              Back
            </Button>
            <Button onClick={onFinish} disabled={busy || aspectRatios.length === 0}>
              {busy ? "Creating…" : "Generate my ads"}
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}

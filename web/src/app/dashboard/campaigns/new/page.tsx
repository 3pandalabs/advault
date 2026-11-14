"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useSyncExternalStore } from "react";
import {
  ApiError,
  assetDownloadUrl,
  createCampaign,
  generateCreatives,
  getNewAdQuote,
  orderNewAd,
  getMe,
  listAssets,
  uploadAsset,
  uploadCreativeVideo,
  type Asset,
} from "@/lib/api/browser";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { FieldHint, Input, Label, Textarea } from "@/components/ui/input";
import { parseDollarsToCents } from "@/lib/utils";
import { AudienceFiltersEditor, HOUSING_NOTICE } from "@/components/AudienceFiltersEditor";
import {
  AUDIENCE_FILTERS_ENABLED,
  CATEGORIES,
  filtersForSave,
  isHousingCategory,
  type AudienceFilters,
} from "@/lib/audience";

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

// Mirror the API's dailyBudgetCents bounds (api/src/routes/campaigns.ts) so the
// form says so up front instead of the server rejecting it after submit.
const MIN_DAILY_BUDGET_CENTS = 100;
const MAX_DAILY_BUDGET_CENTS = 50_000;

// API field names -> the label the advertiser sees, for naming rejected fields.
const FIELD_LABELS: Record<string, string> = {
  name: "campaign name",
  businessName: "business name",
  businessCategory: "category",
  callToAction: "call to action",
  landingUrl: "website link",
  offerDetails: "offer details",
  targetZipCodes: "ZIP/PIN codes",
  radiusMiles: "radius",
  dailyBudgetCents: "daily budget",
  targetAddress: "listing address",
  audienceFilters: "who should see it",
};

const PRESET_CATEGORIES: readonly string[] = CATEGORIES;

const noopSubscribe = () => () => {};

const OFFER_EXAMPLES: Record<string, string> = {
  Plumbing: "$49 drain cleaning this month. Same-day service, 7 days a week. Licensed, family-run since 1998.",
  Electrical: "Free estimates on panel upgrades. EV charger installs from $599. Licensed and insured.",
  HVAC: "AC tune-up $79 until June 30. 24/7 emergency repairs. Financing available.",
  Dentistry: "New patient exam, cleaning and X-rays $49. Evening and Saturday appointments. Most insurance accepted.",
  Restaurant: "Lunch special $12.99, Mon–Fri. Wood-fired pizza, fresh pasta. Free delivery within 3 miles.",
  Landscaping: "Spring cleanup from $149. Weekly mowing from $35. Free quotes, same week.",
  "Auto repair": "Oil change $39.99. Free brake check. Most repairs done same day, 12-month warranty.",
  "Cleaning services": "First home clean 20% off. Eco-friendly products. Insured, background-checked cleaners.",
};
const LISTING_EXAMPLE =
  "New roof 2024, updated kitchen with quartz counters, fenced backyard, two-car garage. Walk to Maple Park.";
const AGENT_EXAMPLE =
  "Sold 40+ homes in Austin last year. Free home valuation. Available evenings and weekends.";

const PHOTO_TIPS: Record<string, string> = {
  Plumbing: "A photo of you or your crew at a job, or with your van.",
  Electrical: "A photo of you or your electrician at work.",
  HVAC: "A photo of your technician at a unit, or with your truck.",
  Dentistry: "A photo of your dentist with a patient, and your front-desk team.",
  Restaurant: "A photo of your cooks in the kitchen, or staff serving guests.",
  Landscaping: "A photo of your crew working on a yard.",
  "Auto repair": "A photo of your mechanic working on a car.",
  "Cleaning services": "A photo of your cleaners at work.",
  "Real estate": "For a listing, the home itself; add your own photo in the next step.",
};

function photoTip(category: string): string {
  if (isHousingCategory(category)) return PHOTO_TIPS["Real estate"];
  return PHOTO_TIPS[category] ?? "A photo of you, your team at work, or a happy customer (with their permission).";
}

function offerPlaceholder(category: string, isListing: boolean): string {
  if (isHousingCategory(category)) return isListing ? LISTING_EXAMPLE : AGENT_EXAMPLE;
  return OFFER_EXAMPLES[category] ?? "Your deal or price, how long it lasts, and what makes you the one to call.";
}

export default function NewCampaignPage() {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  // Where the ad video comes from: photos (AdVault makes it) or a finished MP4
  // the advertiser uploads, in which case nothing is generated. A customer's
  // upload is reviewed by AdVault before it can be launched; an admin's is
  // approved on upload.
  const [source, setSource] = useState<"photos" | "video">("photos");
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [rightsAttested, setRightsAttested] = useState(false);
  const useVideo = source === "video";
  // Must match api/src/lib/uploads/policy.ts.
  const videoLimits = isAdmin ? { minSeconds: 5, maxSeconds: 180 } : { minSeconds: 6, maxSeconds: 60 };

  // Step 1 — assets
  const [assets, setAssets] = useState<Asset[]>([]);
  const [selectedAssetIds, setSelectedAssetIds] = useState<string[]>([]);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  // Photos the advertiser marked as showing people (motion goes to these
  // first), and, for real estate, the agent's own photo.
  const [peopleIds, setPeopleIds] = useState<string[]>([]);
  const [portrait, setPortrait] = useState<{ id: string; url: string } | null>(null);
  const [portraitBusy, setPortraitBusy] = useState(false);
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
    // Real estate only: the listing (or office) the radius is drawn around,
    // the kind of ad, and the listing facts the script uses.
    realtyType: "listing",
    price: "",
    beds: "",
    baths: "",
    ohDate: "",
    ohStart: "",
    ohEnd: "",
    street: "",
    city: "",
    addressState: "",
    addressZip: "",
  });
  // The category dropdown; "Other" reveals the free-text box (form.businessCategory).
  const [categoryChoice, setCategoryChoice] = useState<string>("");
  const [audienceFilters, setAudienceFilters] = useState<AudienceFilters>({});

  // Step 3 — formats
  const [aspectRatios, setAspectRatios] = useState<("16:9" | "9:16")[]>(["16:9", "9:16"]);
  // Keep it running subscribers pay per ad; null means the ad is included.
  const [newAdPrice, setNewAdPrice] = useState<string | null>(null);
  const [freeAd, setFreeAd] = useState(false);

  useEffect(() => {
    // Prefill from the profile so an advertiser who filled this in at signup
    // does not type it again.
    getMe()
      .then((me) => {
        setIsAdmin(me.role === "admin");
        const profileCategory = me.businessCategory ?? "";
        const preset = PRESET_CATEGORIES.includes(profileCategory) && profileCategory !== "Other";
        setCategoryChoice((c) => c || (preset ? profileCategory : profileCategory ? "Other" : ""));
        setForm((f) => ({
          ...f,
          businessName: f.businessName || (me.businessName ?? ""),
          businessCategory: f.businessCategory || (preset ? "" : profileCategory),
          name: f.name || (me.businessName ? `${me.businessName} — local reach` : ""),
        }));
      })
      .catch(() => undefined);

    listAssets().then(setAssets).catch(() => undefined);
    getNewAdQuote()
      .then((q) => {
        setNewAdPrice(q.required ? (q.display ?? null) : null);
        setFreeAd(!!q.required && !!q.freeLaunchOffer);
      })
      .catch(() => undefined);
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
  // 5 digits = US ZIP, 6 digits = Indian PIN. Launch resolves them against one
  // country, so a campaign can't mix the two.
  const invalidZips = zipCodes.filter((z) => !/^\d{5}$|^\d{6}$/.test(z));
  const mixedCountries =
    invalidZips.length === 0 && new Set(zipCodes.map((z) => z.length)).size > 1;
  // The category actually saved: a preset, or the free text behind "Other".
  const category = categoryChoice === "Other" ? form.businessCategory.trim() : categoryChoice;
  // US housing ads (Google policy): no ZIPs, no age/gender/family filters —
  // a radius around the listing instead. The API enforces the same rule.
  const housing = isHousingCategory(category);
  const addressValid =
    form.street.trim() !== "" &&
    form.city.trim() !== "" &&
    /^[A-Za-z]{2}$/.test(form.addressState.trim()) &&
    /^\d{5}$/.test(form.addressZip.trim());
  const isListing = housing && form.realtyType === "listing";
  // Open house: all three or none; end after start.
  const ohAny = form.ohDate !== "" || form.ohStart !== "" || form.ohEnd !== "";
  const ohValid = !ohAny || (form.ohDate !== "" && form.ohStart !== "" && form.ohEnd !== "" && form.ohEnd > form.ohStart);
  const bedsValid = form.beds.trim() === "" || /^\d{1,2}$/.test(form.beds.trim());
  const bathsValid = form.baths.trim() === "" || /^\d{1,2}(\.5)?$/.test(form.baths.trim());
  const realtyValid = !isListing || (ohValid && bedsValid && bathsValid);
  const budgetCents = parseDollarsToCents(form.dailyBudget);
  const budgetOutOfRange =
    budgetCents !== null && (budgetCents < MIN_DAILY_BUDGET_CENTS || budgetCents > MAX_DAILY_BUDGET_CENTS);

  // A phone or tablet (touch-first screen): offer "Take photo" beside the picker.
  // False on the server and during hydration, so the markup matches.
  const hasCamera = useSyncExternalStore(
    noopSubscribe,
    () => window.matchMedia("(pointer: coarse)").matches,
    () => false,
  );

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
        businessCategory: category,
        callToAction: form.callToAction.trim(),
        landingUrl: form.landingUrl.trim(),
        offerDetails: form.offerDetails.trim() || null,
        targetZipCodes: housing ? [] : zipCodes,
        targetAddress: housing
          ? {
              street: form.street.trim(),
              city: form.city.trim(),
              state: form.addressState.trim().toUpperCase(),
              postalCode: form.addressZip.trim(),
            }
          : null,
        radiusMiles: Number(form.radiusMiles),
        dailyBudgetCents,
        audienceFilters: filtersForSave(audienceFilters, housing),
        realty: !housing
          ? null
          : form.realtyType === "agent"
            ? { adType: "agent" }
            : {
                adType: "listing",
                price: form.price.trim() || null,
                beds: form.beds.trim() ? Number(form.beds) : null,
                baths: form.baths.trim() ? Number(form.baths) : null,
                openHouse: ohAny ? { date: form.ohDate, start: form.ohStart, end: form.ohEnd } : null,
              },
      });

      // 202 — the API writes the scripts and queues the renders, then returns.
      // Encoding takes ~30s per creative, so the campaign page polls rather
      // than this request blocking on ffmpeg.
      if (useVideo && videoFile) {
        // The upload replaces generation entirely: generating as well would put
        // AdVault-made videos into the same ad as the uploaded one.
        try {
          await uploadCreativeVideo(campaign.id, videoFile, videoLimits);
        } catch (err) {
          const code = err instanceof ApiError ? err.code : err instanceof Error ? err.message : "error";
          // The campaign exists; send them to it, where the upload card retries.
          setError(`The campaign was created, but the video upload failed (${code}). Opening the campaign so you can upload it again…`);
          setTimeout(() => router.push(`/dashboard/campaigns/${campaign.id}`), 2500);
          return;
        }
      } else if (newAdPrice) {
        // Pay first; the campaign page makes the ad once the payment lands.
        const { checkout } = await orderNewAd(campaign.id, adChoices());
        if (checkout.redirectUrl) {
          window.location.assign(checkout.redirectUrl);
          return;
        }
      } else {
        await generateCreatives(campaign.id, adChoices());
      }
      router.push(`/dashboard/campaigns/${campaign.id}`);
    } catch (err) {
      if (err instanceof ApiError && err.code === "invalid_request") {
        const named = (err.fields ?? []).map((f) => FIELD_LABELS[f] ?? f);
        setError(
          named.length > 0
            ? `Please check: ${[...new Set(named)].join(", ")}.`
            : "Some details were rejected. Check the budget, landing URL and ZIP/PIN codes.",
        );
      } else if (err instanceof ApiError && err.detail) {
        // Targeting rules (housing policy, missing ZIPs/address) carry a
        // sentence written for the advertiser.
        setError(err.detail);
      } else {
        setError("Could not create the campaign. Please try again.");
      }
      setBusy(false);
    }
  }

  // What the ad is made from: the chosen photos in order, then the agent's
  // photo (real estate) last, at most MAX_PHOTOS in all.
  function adChoices() {
    const agent = housing && portrait ? portrait.id : null;
    const photos = selectedAssetIds.filter((id) => id !== agent).slice(0, agent ? MAX_PHOTOS - 1 : MAX_PHOTOS);
    const assetIds = agent ? [...photos, agent] : photos;
    return {
      assetIds,
      aspectRatios,
      peopleAssetIds: peopleIds.filter((id) => assetIds.includes(id)),
      portraitAssetId: agent,
    };
  }

  async function onPortrait(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setPortraitBusy(true);
    setError(null);
    try {
      const asset = await uploadAsset(file, "photo");
      setPortrait({ id: asset.id, url: URL.createObjectURL(file) });
    } catch {
      setError("Photo upload failed. Check your connection and try again.");
    } finally {
      setPortraitBusy(false);
      e.target.value = "";
    }
  }

  const canAdvanceFrom1 = useVideo ? videoFile !== null && rightsAttested : selectedAssetIds.length >= 1;
  const canAdvanceFrom2 =
    form.name.trim() &&
    form.businessName.trim() &&
    category &&
    /^https?:\/\//i.test(form.landingUrl.trim()) &&
    (housing ? addressValid && realtyValid : zipCodes.length > 0 && invalidZips.length === 0 && !mixedCountries) &&
    budgetCents !== null &&
    !budgetOutOfRange;

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">New campaign</h1>

      <ol className="mt-6 mb-8 flex items-center gap-2 text-sm">
        {(useVideo ? ["Video", "Where & how much"] : ["Photos", "Where & how much", "Formats"]).map((label, i, all) => (
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
            {i < all.length - 1 && <span className="text-zinc-700">—</span>}
          </li>
        ))}
      </ol>

      {error && (
        <p className="mb-4 rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2 text-sm text-red-200">
          {error}
        </p>
      )}

      {step === 1 && (
        <div className="mb-4 flex flex-wrap gap-2" role="radiogroup" aria-label="Ad video source">
          {(
            [
              ["photos", "Use photos — AdVault makes the video"],
              ["video", "Use my own video"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={source === value}
              onClick={() => setSource(value)}
              className={`rounded-lg border px-4 py-2 text-sm ${
                source === value
                  ? "border-amber-400 bg-amber-400/10 text-amber-200"
                  : "border-white/10 text-zinc-400 hover:border-white/25"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {step === 1 && useVideo && (
        <Card>
          <CardTitle>Upload the finished ad video</CardTitle>
          <CardDescription>
            MP4, vertical (9:16) for Shorts or wide (16:9) for in-stream, at least 720p,{" "}
            {videoLimits.minSeconds}–{videoLimits.maxSeconds} seconds, up to 200 MB. AdVault makes no
            videos for this campaign.
            {isAdmin
              ? " As an admin, your upload is approved straight away and published to YouTube."
              : " AdVault reviews every uploaded video before it can run, usually within a day; Launch unlocks once it's approved. Google reviews the ad again after launch."}
          </CardDescription>
          <label className="mt-4 flex items-start gap-2 text-sm text-zinc-300">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={rightsAttested}
              onChange={(e) => setRightsAttested(e.target.checked)}
            />
            <span>
              I own or have the rights to everything in this video, including the music. No
              copyrighted music.
            </span>
          </label>
          <div className="mt-5">
            <label className="inline-flex cursor-pointer items-center rounded-lg border border-white/15 bg-white/5 px-4 py-2 text-sm hover:bg-white/10">
              <input
                type="file"
                accept="video/mp4"
                className="hidden"
                onChange={(e) => setVideoFile(e.target.files?.[0] ?? null)}
              />
              {videoFile ? "Choose a different video" : "Choose video"}
            </label>
            {videoFile && (
              <p className="mt-3 text-sm text-zinc-300">
                {videoFile.name} · {(videoFile.size / (1024 * 1024)).toFixed(1)} MB
              </p>
            )}
          </div>
          <div className="mt-6 flex justify-end">
            <Button onClick={() => setStep(2)} disabled={!canAdvanceFrom1}>
              Continue
            </Button>
          </div>
        </Card>
      )}

      {step === 1 && !useVideo && (
        <Card>
          <CardTitle>Add photos of your business</CardTitle>
          <CardDescription>
            Three to five works best. These become the scenes in your ad, so pick shots you
            would show a customer.
          </CardDescription>
          <p className="mt-3 rounded-lg border border-amber-400/20 bg-amber-400/5 px-3 py-2 text-sm text-zinc-300">
            <span className="font-medium text-amber-300">Include people.</span>{" "}
            {photoTip(category)} Ads with real people from your business feel alive: we
            animate those photos first.
          </p>

          <div className="mt-5 flex flex-wrap gap-2">
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
            {/* Phones only: capture opens the rear camera directly (Chrome asks
                for camera permission the first time, in the Android app too).
                On a desktop it would just open the same file picker twice. */}
            {hasCamera && (
              <label className="inline-flex cursor-pointer items-center rounded-lg border border-white/15 bg-white/5 px-4 py-2 text-sm hover:bg-white/10">
                <input
                  type="file"
                  accept="image/jpeg"
                  capture="environment"
                  className="hidden"
                  onChange={onUpload}
                  disabled={uploading}
                />
                Take photo
              </label>
            )}
          </div>
          <div>
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
                    {index >= 0 && (
                      <span
                        role="checkbox"
                        aria-checked={peopleIds.includes(asset.id)}
                        tabIndex={0}
                        onClick={(e) => {
                          e.stopPropagation();
                          setPeopleIds((p) => (p.includes(asset.id) ? p.filter((x) => x !== asset.id) : [...p, asset.id]));
                        }}
                        onKeyDown={(e) => {
                          if (e.key !== " " && e.key !== "Enter") return;
                          e.preventDefault();
                          e.stopPropagation();
                          setPeopleIds((p) => (p.includes(asset.id) ? p.filter((x) => x !== asset.id) : [...p, asset.id]));
                        }}
                        className={`absolute bottom-1 left-1 right-1 rounded-md px-2 py-1 text-center text-[11px] font-medium ${
                          peopleIds.includes(asset.id) ? "bg-amber-400 text-zinc-950" : "bg-black/70 text-zinc-200 hover:bg-black/85"
                        }`}
                      >
                        {peopleIds.includes(asset.id) ? "✓ People in it" : "People in it?"}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}

          <p className="mt-4 text-xs text-zinc-500">
            Selected photos play in the order you picked them. Tap &quot;People in it?&quot; on
            photos that show you, your team or your customers.
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
                <Label htmlFor="categoryChoice">Category</Label>
                <select
                  id="categoryChoice"
                  value={categoryChoice}
                  onChange={(e) => setCategoryChoice(e.target.value)}
                  className="h-10 w-full rounded-lg border border-white/15 bg-white/5 px-3 text-sm text-zinc-100 focus:border-amber-400/60 focus:outline-none focus:ring-1 focus:ring-amber-400/60"
                >
                  <option value="" className="bg-zinc-900">
                    Choose…
                  </option>
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c} className="bg-zinc-900">
                      {c === "Real estate" ? "Real estate (agent, listings, open house)" : c}
                    </option>
                  ))}
                </select>
                {categoryChoice === "Other" && (
                  <Input
                    id="businessCategory"
                    aria-label="Your category"
                    className="mt-2"
                    value={form.businessCategory}
                    onChange={set("businessCategory")}
                    placeholder="Pet grooming"
                    maxLength={80}
                  />
                )}
              </div>
            </div>

            {housing && (
              <div>
                <Label className="flex items-center gap-2">
                  Your photo
                  <span className="rounded-full bg-amber-400/15 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-amber-300">
                    Recommended
                  </span>
                </Label>
                <div className="mt-2 flex items-center gap-3">
                  {portrait ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={portrait.url} alt="Your photo" className="h-16 w-16 rounded-full object-cover ring-2 ring-amber-400" />
                  ) : (
                    <span className="flex h-16 w-16 items-center justify-center rounded-full border border-dashed border-white/20 text-xs text-zinc-500">
                      You
                    </span>
                  )}
                  <label className="inline-flex cursor-pointer items-center rounded-lg border border-white/15 bg-white/5 px-4 py-2 text-sm hover:bg-white/10">
                    <input type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={onPortrait} disabled={portraitBusy} />
                    {portraitBusy ? "Uploading…" : portrait ? "Change photo" : "Add your photo"}
                  </label>
                  {portrait && (
                    <Button type="button" variant="ghost" size="sm" onClick={() => setPortrait(null)}>
                      Remove
                    </Button>
                  )}
                </div>
                <FieldHint>
                  A clear photo of you, the agent. It closes the ad next to &quot;Call&quot;:
                  people call a face they recognise.
                </FieldHint>
              </div>
            )}

            {housing && (
              <div>
                <Label>What is this ad for?</Label>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  {[
                    { v: "listing", t: "A listing or open house", h: "One home for sale: the address, price and open house time are in the ad." },
                    { v: "agent", t: "Me, as an agent", h: "Promote yourself and the area you serve, not one home." },
                  ].map((o) => (
                    <label
                      key={o.v}
                      className={`flex cursor-pointer gap-3 rounded-lg border p-3 ${form.realtyType === o.v ? "border-amber-400/70 bg-amber-400/5" : "border-white/15 bg-white/[0.02] hover:border-white/25"}`}
                    >
                      <input
                        type="radio"
                        name="realtyType"
                        value={o.v}
                        checked={form.realtyType === o.v}
                        onChange={() => setForm((f) => ({ ...f, realtyType: o.v }))}
                        className="mt-1 accent-amber-400"
                      />
                      <span>
                        <span className="block text-sm font-medium text-zinc-100">{o.t}</span>
                        <span className="block text-xs text-zinc-500">{o.h}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            {housing ? (
              <div>
                <Label htmlFor="street">{isListing ? "Listing address" : "Office address, or the center of the area you serve"}</Label>
                <FieldHint>
                  Housing ads in the US can&apos;t target ZIP codes (Google policy), so we show
                  your ad to people within the radius below of this address.
                  {isListing ? " The street is said in the ad." : " Only the city appears in the ad."}
                </FieldHint>
                <div className="mt-2 grid gap-2 sm:grid-cols-6">
                  <Input
                    id="street"
                    className="sm:col-span-6"
                    placeholder="123 Main St"
                    value={form.street}
                    onChange={set("street")}
                    maxLength={200}
                  />
                  <Input
                    aria-label="City"
                    className="sm:col-span-3"
                    placeholder="City"
                    value={form.city}
                    onChange={set("city")}
                    maxLength={100}
                  />
                  <Input
                    aria-label="State"
                    className="sm:col-span-1"
                    placeholder="TX"
                    maxLength={2}
                    value={form.addressState}
                    onChange={set("addressState")}
                  />
                  <Input
                    aria-label="ZIP"
                    className="sm:col-span-2"
                    placeholder="78701"
                    inputMode="numeric"
                    maxLength={5}
                    value={form.addressZip}
                    onChange={set("addressZip")}
                  />
                </div>
                {isListing && (
                  <>
                    <div className="mt-4 grid gap-2 sm:grid-cols-3">
                      <div>
                        <Label htmlFor="price">Price</Label>
                        <Input id="price" placeholder="$489,000" maxLength={20} value={form.price} onChange={set("price")} />
                      </div>
                      <div>
                        <Label htmlFor="beds">Bedrooms</Label>
                        <Input id="beds" inputMode="numeric" placeholder="3" maxLength={2} value={form.beds} onChange={set("beds")} />
                      </div>
                      <div>
                        <Label htmlFor="baths">Bathrooms</Label>
                        <Input id="baths" inputMode="decimal" placeholder="2.5" maxLength={4} value={form.baths} onChange={set("baths")} />
                      </div>
                    </div>
                    {(!bedsValid || !bathsValid) && (
                      <p className="mt-1.5 text-xs text-red-300">Bedrooms is a whole number; bathrooms can end in .5.</p>
                    )}
                    <div className="mt-4">
                      <Label htmlFor="ohDate">Open house (optional)</Label>
                      <div className="mt-2 grid gap-2 sm:grid-cols-3">
                        <Input id="ohDate" type="date" aria-label="Open house date" value={form.ohDate} onChange={set("ohDate")} />
                        <Input type="time" aria-label="Starts" value={form.ohStart} onChange={set("ohStart")} />
                        <Input type="time" aria-label="Ends" value={form.ohEnd} onChange={set("ohEnd")} />
                      </div>
                      {ohValid ? (
                        <FieldHint>Date, start and end. The ad says it, for example &quot;Open house Sunday, 1–4 PM&quot;.</FieldHint>
                      ) : (
                        <p className="mt-1.5 text-xs text-red-300">Fill in the date, start and end, with the end after the start.</p>
                      )}
                    </div>
                  </>
                )}
              </div>
            ) : (
            <div>
              <Label htmlFor="zipInput">Target ZIP or PIN codes</Label>
              <Textarea
                id="zipInput"
                value={form.zipInput}
                onChange={set("zipInput")}
                placeholder="94110, 94103 — or 560038, 560008"
                className="min-h-20"
              />
              {invalidZips.length > 0 ? (
                <p className="mt-1.5 text-xs text-red-300">
                  Not a 5-digit US ZIP or 6-digit Indian PIN code: {invalidZips.join(", ")}
                </p>
              ) : mixedCountries ? (
                <p className="mt-1.5 text-xs text-red-300">
                  Use either US ZIP codes or Indian PIN codes in one campaign, not both.
                </p>
              ) : (
                <FieldHint>
                  {zipCodes.length > 0
                    ? `${zipCodes.length} ${zipCodes[0].length === 6 ? "PIN" : "ZIP"} code${zipCodes.length === 1 ? "" : "s"}`
                    : "5-digit US ZIP or 6-digit Indian PIN. Separate with commas or spaces."}
                </FieldHint>
              )}
            </div>
            )}

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
                <FieldHint>
                  {housing
                    ? "How far around the listing to reach. Max 50."
                    : "How far around those codes to reach. Max 50."}
                </FieldHint>
              </div>
              <div>
                <Label htmlFor="dailyBudget">Daily budget (USD)</Label>
                <Input
                  id="dailyBudget"
                  inputMode="decimal"
                  value={form.dailyBudget}
                  onChange={set("dailyBudget")}
                />
                {budgetCents === null && form.dailyBudget.trim() !== "" ? (
                  <p className="mt-1.5 text-xs text-red-300">Enter a number, for example 15.</p>
                ) : budgetOutOfRange ? (
                  <p className="mt-1.5 text-xs text-red-300">
                    Must be between {MIN_DAILY_BUDGET_CENTS / 100} and{" "}
                    {MAX_DAILY_BUDGET_CENTS / 100} a day.
                  </p>
                ) : (
                  <FieldHint>
                    Between {MIN_DAILY_BUDGET_CENTS / 100} and {MAX_DAILY_BUDGET_CENTS / 100} a
                    day. Google never charges more than this per day.
                  </FieldHint>
                )}
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
              <Label htmlFor="offerDetails" className="flex items-center gap-2">
                Your offer and what makes you different
                <span className="rounded-full bg-amber-400/15 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-amber-300">
                  Highly recommended
                </span>
              </Label>
              <Textarea
                id="offerDetails"
                maxLength={2000}
                value={form.offerDetails}
                onChange={set("offerDetails")}
                placeholder={offerPlaceholder(category, isListing)}
                className="min-h-24"
              />
              {form.offerDetails.trim() === "" ? (
                <p className="mt-1.5 text-xs text-amber-300/90">
                  This is what your ad says. Leave it empty and the ad can only say your name and
                  what you do: no price, no deal, no reason to call you today. A price or discount
                  appears in the ad only if you write it here.
                </p>
              ) : (
                <FieldHint>
                  Used to write the script. Only include things that are true: your ad is a public
                  statement about your business.
                </FieldHint>
              )}
            </div>

            {AUDIENCE_FILTERS_ENABLED ? (
              <AudienceFiltersEditor
                value={audienceFilters}
                onChange={setAudienceFilters}
                housing={housing}
              />
            ) : (
              housing && (
                <p className="rounded-lg border border-sky-400/30 bg-sky-400/10 px-3 py-2 text-xs text-sky-200">
                  {HOUSING_NOTICE}
                </p>
              )
            )}
          </div>

          <div className="mt-6 flex justify-between">
            <Button variant="ghost" onClick={() => setStep(1)}>
              Back
            </Button>
            {useVideo ? (
              <Button onClick={onFinish} disabled={busy || !canAdvanceFrom2}>
                {busy ? "Creating and uploading…" : "Create campaign and upload video"}
              </Button>
            ) : (
              <Button onClick={() => setStep(3)} disabled={!canAdvanceFrom2}>
                Continue
              </Button>
            )}
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

          {freeAd ? (
            <p className="mt-5 text-sm text-zinc-400">
              Launch offer: your first ad is free (normally $10).
              We write the script and render your videos. Nothing runs until you launch.
            </p>
          ) : newAdPrice ? (
            <p className="mt-5 text-sm text-zinc-400">
              Making your ad costs {newAdPrice}, including up to two redos. You pay now, then we
              write the script and render your videos. Nothing runs until you launch.
            </p>
          ) : (
            <p className="mt-5 text-sm text-zinc-400">
              We will write the script and render your videos. Nothing is charged and no ad runs
              until you connect Google Ads and launch — and even then the campaign is created
              paused.
            </p>
          )}

          <div className="mt-6 flex justify-between">
            <Button variant="ghost" onClick={() => setStep(2)}>
              Back
            </Button>
            <Button onClick={onFinish} disabled={busy || aspectRatios.length === 0}>
              {busy ? "Creating…" : freeAd ? "Make my free ad" : newAdPrice ? `Pay ${newAdPrice} and make my ad` : "Generate my ads"}
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}

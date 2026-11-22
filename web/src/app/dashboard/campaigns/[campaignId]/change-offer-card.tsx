"use client";

import { useEffect, useState } from "react";
import {
  ApiError,
  cancelOfferChange,
  confirmOfferChange,
  createOfferChange,
  getOfferChanges,
  resumeOfferChangeCheckout,
  uploadAsset,
  type Campaign,
  type OfferChange,
  type OfferChangeState,
} from "@/lib/api/browser";
import { Badge, Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { ClaimWarnings, hasBlockedClaim } from "@/components/ClaimWarnings";
import { AttestationChecks, useAttestation } from "@/components/AttestationChecks";
import { formatDate } from "@/lib/utils";
import { WhatsAppPrompt } from "@/components/WhatsAppOptIn";
import { EstimateProgress } from "./render-progress";

// "Change my offer" (api lib/offerSwap, 2026-11-21) on a launched campaign.
// A cheap re-cut of the running ad with the new offer: same photos, motion
// and voice, only the offer words change. The owner watches the preview,
// presses "Put it live" ($2, or included once a month on Keep it running),
// and AdVault adds it at Google next to the running ad. The running ad keeps
// showing until Google approves the new one, then they swap. On the end
// date the ad goes back to the regular ad and keeps running. When the
// running ad is the owner's own video (mode "slide"), the change is that same
// video with a "This month's offer" slide added at the end (no new photo).

const ERRORS: Record<string, string> = {
  claim_not_allowed: "That wording isn't allowed in an ad.",
  offer_change_in_progress: "Your last offer change is still with Google. You can make another once it's live.",
  offer_change_daily_limit: "That's the most new versions we can make today. Please try again tomorrow.",
  ends_on_in_past: "Pick an end date from today on.",
  ends_on_too_far: "Pick an end date within the next 3 months.",
  ends_on_invalid: "Pick a valid end date.",
  needs_review: "Some wording is checked by AdVault before it can run. We usually review within a day; then press Put it live again.",
  photo_not_for_upload_ads: "Your ad is your own video, so the offer goes on a slide at the end. A new photo isn't used.",
  offer_change_not_available: "Offer changes aren't available for this account.",
  attestation_required: "Tick both boxes first.",
  terms_not_accepted: "Please accept the updated terms first.",
};

function message(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return ERRORS[err.code] ?? err.detail ?? fallback;
  return fallback;
}

const today = () => new Date().toISOString().slice(0, 10);

export function ChangeOfferCard({ campaign }: { campaign: Campaign }) {
  const [state, setState] = useState<OfferChangeState | null>(null);
  const [editing, setEditing] = useState(
    () => typeof window !== "undefined" && new URLSearchParams(window.location.search).get("edit") === "offer",
  );
  const [offer, setOffer] = useState("");
  const [endsOn, setEndsOn] = useState("");
  const [photo, setPhoto] = useState<File | null>(null);
  const [ticks, setTicks, attestation] = useAttestation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped to reload; also re-polls while something is being made or is
  // with Google (5 s while making or publishing, so "Ready to check" shows
  // the moment the API says preview; 30 s while waiting on payment / Google).
  const [rev, setRev] = useState(0);
  const reload = () => setRev((n) => n + 1);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    getOfferChanges(campaign.id)
      .then((s) => {
        if (cancelled) return;
        setState(s);
        const stage = s.current?.stage;
        if (stage === "making" || stage === "waiting_payment" || stage === "waiting_google") {
          const fast = stage === "making" || s.current?.status === "publishing";
          timer = setTimeout(() => setRev((n) => n + 1), fast ? 5000 : 30000);
        }
      })
      .catch(() => {
        if (!cancelled) setState(null);
      });
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [campaign.id, rev]);

  if (!state) return null;
  if (!state.eligible) return null;

  const { quote, current, live } = state;
  // Their own video: the offer goes on an end slide, so no new photo.
  const slide = state.mode === "slide";
  const priceLine =
    quote.charge === "exempt"
      ? "Free for your account."
      : quote.charge === "included"
        ? "Included in your plan (1 offer change a month)."
        : `${quote.display} for this change.${quote.planIncludesChanges ? " Your plan's free change this month is used." : ""}`;
  const blocked = hasBlockedClaim(campaign.businessCategory, offer);

  async function make() {
    if (!attestation) return;
    setBusy(true);
    setError(null);
    try {
      const photoAssetId = photo && !slide ? (await uploadAsset(photo, "photo")).id : null;
      await createOfferChange(campaign.id, { offerText: offer.trim(), endsOn: endsOn || null, photoAssetId, attestation });
      setEditing(false);
      setOffer("");
      setEndsOn("");
      setPhoto(null);
      reload();
    } catch (err) {
      setError(message(err, "We couldn't make it. Please try again."));
    } finally {
      setBusy(false);
    }
  }

  async function putLive(change: OfferChange) {
    setBusy(true);
    setError(null);
    try {
      const res = await confirmOfferChange(change.id);
      if (res.status === "awaiting_payment" && res.checkoutUrl) {
        window.location.href = res.checkoutUrl;
        return;
      }
      reload();
    } catch (err) {
      setError(message(err, "We couldn't put it live. Please try again."));
    } finally {
      setBusy(false);
    }
  }

  async function payAgain(change: OfferChange) {
    setBusy(true);
    try {
      const res = await resumeOfferChangeCheckout(change.id);
      if (res.checkoutUrl) window.location.href = res.checkoutUrl;
    } catch (err) {
      setError(message(err, "We couldn't open the payment. Please try again."));
    } finally {
      setBusy(false);
    }
  }

  async function notNow(change: OfferChange) {
    setBusy(true);
    try {
      await cancelOfferChange(change.id);
      reload();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card id="change-offer" className="mb-4 scroll-mt-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <CardTitle>Change my offer</CardTitle>
          <CardDescription className="break-words">
            {live?.offerText && live.endsAt
              ? `Running now: “${live.offerText}” until ${formatDate(live.endsAt)}. Then your regular ad comes back.`
              : state.lastEnded?.endedAt
                ? `Back to your regular ad since ${formatDate(state.lastEnded.endedAt)}.`
                : slide
                  ? "Put a new deal in your running ad. We add a “This month's offer” slide at the end of your video. Your ad keeps running while Google checks it."
                  : "Put a new deal in your running ad. Same photos and voice, new offer. Your ad keeps running while Google checks it."}
          </CardDescription>
        </div>
        {state.eligible && !editing && !current && (
          <Button size="sm" onClick={() => setEditing(true)}>
            Change my offer
          </Button>
        )}
      </div>

      {state.lastProblem && (
        <p className="mt-3 text-sm text-red-300">
          {state.lastProblem.status === "disapproved"
            ? `Google didn't approve the ad with “${state.lastProblem.offerText ?? ""}”, so your current ad keeps running. Try different wording.`
            : "We couldn't make your last offer change. Your current ad keeps running. Please try again."}
        </p>
      )}

      {current && <CurrentChange change={current} busy={busy} onPutLive={putLive} onPay={payAgain} onCancel={notNow} priceLine={priceLine} />}

      {editing && !current && (
        <div className="mt-4 space-y-3 text-sm">
          <div>
            <Label htmlFor="new-offer">Your new offer</Label>
            <Textarea
              id="new-offer"
              maxLength={500}
              value={offer}
              onChange={(e) => setOffer(e.target.value)}
              className="min-h-20"
              placeholder="$25 off any move-out clean until Dec 15"
              disabled={busy}
            />
            <ClaimWarnings category={campaign.businessCategory} text={offer} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="offer-ends">Ends on (optional)</Label>
              <Input id="offer-ends" type="date" min={today()} value={endsOn} onChange={(e) => setEndsOn(e.target.value)} disabled={busy} />
              <p className="mt-1 text-xs text-zinc-500">
                No date? We read it from your offer, else the end of the month.{slide ? " The slide shows it as “Until …”." : ""}
              </p>
            </div>
            {!slide && (
              <div>
                <Label htmlFor="offer-photo">One new photo (optional)</Label>
                <Input
                  id="offer-photo"
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  capture="environment"
                  onChange={(e) => setPhoto(e.target.files?.[0] ?? null)}
                  disabled={busy}
                />
                <p className="mt-1 text-xs text-zinc-500">It opens your ad. Leave empty to keep your photos.</p>
              </div>
            )}
          </div>
          <p className="text-zinc-300">{priceLine} You only pay when you press Put it live.</p>
          <AttestationChecks value={ticks} onChange={setTicks} disabled={busy} />
          <div className="flex flex-wrap gap-2">
            <Button onClick={make} disabled={busy || offer.trim().length < 3 || blocked || !attestation}>
              {busy ? "Making it…" : "Make a preview"}
            </Button>
            <Button variant="ghost" onClick={() => setEditing(false)} disabled={busy}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {error && <p className="mt-3 text-sm text-red-300">{error}</p>}
      {/* The WhatsApp way: the "WhatsApp your new offer" note when it answers
          them, else the optional add-number box. */}
      {!editing && <WhatsAppPrompt className="mt-4" title="Next time, change it from WhatsApp" />}
    </Card>
  );
}

function CurrentChange({
  change,
  busy,
  priceLine,
  onPutLive,
  onPay,
  onCancel,
}: {
  change: OfferChange;
  busy: boolean;
  priceLine: string;
  onPutLive: (c: OfferChange) => void;
  onPay: (c: OfferChange) => void;
  onCancel: (c: OfferChange) => void;
}) {
  const label: Record<string, [string, "pending" | "success" | "danger" | "neutral"]> = {
    making: ["Making your new ad", "pending"],
    preview: ["Ready to check", "neutral"],
    waiting_payment: ["Waiting for payment", "pending"],
    waiting_google: ["Waiting for Google's approval", "pending"],
  };
  // publishing (YouTube upload + adding it at Google, a couple of minutes)
  // and pending_google (Google's review, hours) share the stage word.
  const publishing = change.status === "publishing";
  const [text, tone] = publishing ? (["Sending it to Google", "pending"] as const) : (label[change.stage] ?? ["", "neutral"]);
  return (
    <div className="mt-4 space-y-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={tone}>{text}</Badge>
        <span className="break-words text-zinc-300">“{change.offerText}”{change.endsAt ? ` until ${formatDate(change.endsAt)}` : ""}</span>
      </div>
      {change.stage === "making" &&
        (change.progress ? (
          <EstimateProgress
            startedAt={change.progress.startedAt}
            expectedSeconds={change.progress.expectedSeconds}
            label="Making your new ad"
            note="You can leave this page; it keeps going. The video shows here as soon as it's ready."
          />
        ) : (
          <p className="text-zinc-400">Usually a few minutes. You can leave this page.</p>
        ))}
      {publishing && change.progress && (
        <EstimateProgress
          startedAt={change.progress.startedAt}
          expectedSeconds={change.progress.expectedSeconds}
          label="Sending your new ad to Google"
          note="Your current ad keeps running meanwhile."
        />
      )}
      {change.stage === "waiting_google" && !publishing && (
        <p className="text-zinc-400">
          Google is checking your new ad. This can take a few hours, sometimes up to a day. Your current ad keeps running until Google approves it, then they swap by themselves.
        </p>
      )}
      {change.reviewPhrases.length > 0 && (
        <p className="text-amber-200">AdVault checks “{change.reviewPhrases[0]!.phrase}” before it can run: {change.reviewPhrases[0]!.reason}</p>
      )}
      {change.stage === "preview" && (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            {change.creatives
              .filter((c) => c.videoUrl)
              .map((c) => (
                <figure key={c.id} className="min-w-0">
                  <video
                    src={c.videoUrl!}
                    poster={c.thumbnailUrl ?? undefined}
                    controls
                    playsInline
                    className={`w-full rounded-lg bg-black ${c.aspectRatio === "9:16" ? "mx-auto aspect-[9/16] max-w-[240px]" : "aspect-video"}`}
                  />
                  <figcaption className="mt-1 text-xs text-zinc-500">{c.aspectRatio === "9:16" ? "Vertical (Shorts)" : "Widescreen (YouTube)"}</figcaption>
                </figure>
              ))}
          </div>
          {change.endsAtInferred && change.endsAt && (
            <p className="text-zinc-400">We set it to end on {formatDate(change.endsAt)}. To change that, make it again with a date.</p>
          )}
          <p className="text-zinc-300">{priceLine}</p>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => onPutLive(change)} disabled={busy}>
              Put it live
            </Button>
            <Button variant="ghost" onClick={() => onCancel(change)} disabled={busy}>
              Not now
            </Button>
          </div>
        </>
      )}
      {change.stage === "waiting_payment" && (
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => onPay(change)} disabled={busy}>
            Pay and put it live
          </Button>
          <Button variant="ghost" onClick={() => onCancel(change)} disabled={busy}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}

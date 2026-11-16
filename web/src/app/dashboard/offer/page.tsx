"use client";

import { useEffect, useState } from "react";
import {
  ApiError,
  approveOffer,
  currentOffer,
  submitOffer,
  type OfferCycle,
} from "@/lib/api/browser";
import { Badge, Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/utils";
import { SuggestionChips } from "@/components/SuggestionChips";
import { GENERIC_MONTHLY_OFFER } from "@/lib/suggestions";

// This month's offer.
//
// The primary interface for this is WhatsApp, not this page — a shop owner will
// not open a dashboard on the 1st of the month, but they will reply to a
// message. This exists as the fallback: for owners who prefer a screen, for
// numbers that have no WhatsApp, and for when Meta's API is unavailable. Every
// step of the conversation has an HTTP equivalent for that reason.

const STATUS_COPY: Record<OfferCycle["status"], string> = {
  pending: "Not set yet",
  prompted: "We've asked — waiting on your offer",
  answered: "Got it — making your videos",
  previewed: "Ready for your approval",
  approved: "Live",
  skipped: "Skipped this month",
};

export default function OfferPage() {
  const [cycle, setCycle] = useState<OfferCycle | null>(null);
  const [whatsappEnabled, setWhatsappEnabled] = useState(false);
  const [text, setText] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [inferred, setInferred] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = () =>
    currentOffer()
      .then((r) => {
        setCycle(r.cycle);
        setWhatsappEnabled(r.whatsappEnabled);
      })
      .catch(() => setError("Could not load this month's offer."));

  useEffect(() => {
    void refresh();
  }, []);

  async function onSubmit() {
    setBusy(true);
    setError(null);
    try {
      const result = await submitOffer(text, expiresAt ? new Date(expiresAt).toISOString() : undefined);
      // The deadline is a guess when the owner didn't state one, and saying so
      // matters: an offer left running past its date spends their budget
      // sending people to a deal the shop won't honour.
      setInferred(result.expiryInferred);
      await refresh();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "";
      setError(
        code === "plan_has_no_offers"
          ? "Keep it running doesn't include monthly offers. To advertise a new deal, open your campaign and make a new ad with it ($10)."
          : code === "no_subscription"
            ? "Monthly offers come with a monthly-offer plan, coming soon. To advertise a deal now, put it in your campaign's offer and make a new ad."
            : "Could not save your offer. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function onApprove() {
    if (!cycle) return;
    setBusy(true);
    try {
      await approveOffer(cycle.id);
      await refresh();
    } catch {
      setError("Could not approve just now.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">This month&apos;s offer</h1>
        <p className="mt-1 text-sm text-zinc-400">
          Tell us the deal — &ldquo;30% off colouring till the 15th&rdquo; — and we&apos;ll have the
          ad ready today.
        </p>
      </div>

      {whatsappEnabled ? (
        <p className="rounded-lg border border-white/10 bg-white/[0.02] p-3 text-sm text-zinc-400">
          We&apos;ll message you on WhatsApp at the start of each month. Replying there is quicker
          than this page — it&apos;s the same thing.
        </p>
      ) : null}

      {error ? <p className="text-sm text-red-400">{error}</p> : null}

      {cycle ? (
        <Card>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <CardTitle>{STATUS_COPY[cycle.status]}</CardTitle>
              <CardDescription>
                {cycle.offerText ?? "No offer recorded for this month yet."}
              </CardDescription>
            </div>
            <Badge>{formatDate(cycle.periodMonth)}</Badge>
          </div>

          {cycle.offerExpiresAt ? (
            <p className="mt-3 text-sm text-zinc-400">
              Stops automatically on {formatDate(cycle.offerExpiresAt)}.
              {inferred ? " We guessed this date — change it below if it's wrong." : ""}
            </p>
          ) : null}

          {cycle.status === "previewed" ? (
            <Button className="mt-4" onClick={onApprove} disabled={busy}>
              Put it live
            </Button>
          ) : null}
        </Card>
      ) : null}

      <Card>
        <CardTitle>Set or change the offer</CardTitle>
        <CardDescription>
          Replacing it re-makes this month&apos;s videos with the new deal.
        </CardDescription>
        <textarea
          id="offer-text"
          aria-label="This month's offer"
          className="mt-4 w-full rounded-lg border border-white/10 bg-black/20 p-3 text-sm"
          rows={3}
          maxLength={500}
          placeholder="30% off colouring till the 15th"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        {/* This month's recorded offer (to tweak it), else a generic starting point. */}
        <SuggestionChips
          targetId="offer-text"
          fieldLabel="offer"
          value={text}
          suggestions={[cycle?.offerText, GENERIC_MONTHLY_OFFER]}
          onPick={setText}
        />
        <label className="mt-3 block text-sm text-zinc-400">
          Last day (optional — we&apos;ll work it out from your wording)
          <input
            type="date"
            className="mt-1 block rounded-lg border border-white/10 bg-black/20 p-2 text-sm"
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
          />
        </label>
        <Button className="mt-4" onClick={onSubmit} disabled={busy || text.trim().length < 3}>
          Save offer
        </Button>
      </Card>
    </div>
  );
}

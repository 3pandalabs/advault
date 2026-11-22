"use client";

import { useId, useState } from "react";
import Link from "next/link";
import type { Campaign, CampaignStats, CampaignStatus, WhatsAppState } from "@/lib/api/browser";
import { WhatsAppOfferLine } from "@/components/WhatsAppOptIn";
import { AUDIENCE_FILTERS_ENABLED } from "@/lib/audience";
import { Badge, Card, CardDescription, CardTitle } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ResultsCard } from "./campaigns/[campaignId]/results-card";
import { formatDate, formatRelative } from "@/lib/utils";

// One campaign on the dashboard list (2026-11-20): status, a stats summary
// once the ad has launched (with "See details" = the campaign page's results
// screen, loaded on open, 2026-11-21), and action buttons that deep-link into the campaign
// page's own editors (never a copy of them), as a visible button row. Every campaign here is the
// caller's own: GET /campaigns and GET /campaigns/stats only return those.

const STATUS_TONE: Record<CampaignStatus, "neutral" | "pending" | "success" | "danger"> = {
  draft: "neutral",
  rendering: "pending",
  ready: "pending",
  live: "success",
  paused: "neutral",
  failed: "danger",
};

const STATUS_LABEL: Record<CampaignStatus, string> = {
  draft: "Draft",
  rendering: "Rendering",
  ready: "Ready to launch",
  live: "Live",
  paused: "Paused",
  failed: "Launch failed",
};

const count = new Intl.NumberFormat("en-US");

/** Launched = a Google campaign exists and it's live or paused. */
export function isLaunched(c: Campaign): boolean {
  return Boolean(c.googleCampaignResourceName) && (c.status === "live" || c.status === "paused");
}

type Action = { label: string; href: string };

function actionsFor(c: Campaign, stats: CampaignStats | undefined): Action[] {
  const page = `/dashboard/campaigns/${c.id}`;
  const out: Action[] = [{ label: "Open campaign", href: page }];
  // AdVault removed this ad: nothing to change or fund (the API refuses too).
  if (c.complianceStatus === "taken_down") return out;
  // "Change my offer" (api lib/offerSwap): a running (or paused) launched ad.
  if (isLaunched(c)) out.push({ label: "Change my offer", href: `${page}?edit=offer#change-offer` });
  // Same rule as the campaign page's "Who should see it" card.
  if (AUDIENCE_FILTERS_ENABLED || c.audienceFilters || c.googleCampaignResourceName) {
    out.push({ label: "Change audience", href: `${page}?edit=audience#audience` });
  }
  // The AdVault ad budget pays: top up on the campaign page (checkout comes
  // back to it). Launched on the customer's own Google billing: nothing of
  // ours to top up. Not launched yet: the Balance page.
  if (stats?.walletPays) {
    out.push({ label: "Top up budget", href: `${page}#ad-budget` });
  } else if (!c.googleCampaignResourceName) {
    out.push({ label: "Top up budget", href: "/dashboard/wallet" });
  }
  return out;
}

/** "12.5%" from a 0..1 rate. */
function rate(r: number | null): string | null {
  if (r === null || !Number.isFinite(r)) return null;
  const p = r * 100;
  return `${p >= 10 ? Math.round(p) : Number(p.toFixed(1))}%`;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2">
      <dt className="text-xs text-zinc-500">{label}</dt>
      <dd className="mt-0.5 text-xl font-semibold tabular-nums text-amber-300">{value}</dd>
    </div>
  );
}

/**
 * The headline numbers since launch (2026-11-21: bigger, so customers see
 * them without opening the campaign), plus "See details", which mounts the
 * campaign page's own results screen inline. It fetches only when opened, so
 * the list stays at one stats call however many campaigns there are.
 */
function StatsSummary({ campaignId, stats }: { campaignId: string; stats: CampaignStats | undefined }) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  // Still loading, or the stats call failed: say nothing rather than zeros.
  if (!stats) return null;
  const t = stats.totals;
  if (!t || t.impressions === 0) {
    return (
      <p className="mt-4 border-t border-white/10 pt-3 text-xs text-zinc-400">
        Stats appear once Google starts showing your ad (usually within a day of launch).
      </p>
    );
  }
  const viewRate = rate(t.viewRate);
  const clickRate = rate(t.ctr);
  return (
    <div className="mt-4 border-t border-white/10 pt-3">
      {t.views > 0 && t.costPerViewDisplay && (
        <p className="text-sm text-zinc-200">
          <span className="font-semibold">{count.format(t.views)} people watched</span> your ad at{" "}
          <span className="font-semibold text-amber-300">{t.costPerViewDisplay} a view</span>
        </p>
      )}
      <dl className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Times shown" value={count.format(t.impressions)} />
        <Stat label="Views" value={count.format(t.views)} />
        <Stat label="Clicks" value={count.format(t.clicks)} />
        <Stat label="Spent" value={t.spendDisplay} />
        {/* Only for ads that land on advault.3pandalabs.com (siteVisits null otherwise). */}
        {typeof stats.siteVisits === "number" && (
          <div className="col-span-2 sm:col-span-4">
            <Stat label="Visits to your website from this ad" value={count.format(stats.siteVisits)} />
          </div>
        )}
      </dl>
      {(viewRate || clickRate) && (
        <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-400">
          {viewRate && (
            <span>
              View rate <span className="font-semibold tabular-nums text-zinc-100">{viewRate}</span>
            </span>
          )}
          {clickRate && (
            <span>
              Click rate <span className="font-semibold tabular-nums text-zinc-100">{clickRate}</span>
            </span>
          )}
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-zinc-500">
          Since launch
          {stats.lastSyncedAt && <> &middot; Updated {formatRelative(stats.lastSyncedAt)}</>} &middot; Google
          reports lag a few hours
        </p>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={detailsId}
          onClick={() => setOpen((o) => !o)}
          className="text-sm font-medium text-amber-300 underline-offset-4 hover:underline"
        >
          {open ? "Hide details ▴" : "See details ▾"}
        </button>
      </div>
      {open && (
        <div id={detailsId} className="mt-3 rounded-xl border border-white/10 bg-black/20 p-3 sm:p-4">
          <ResultsCard campaignId={campaignId} embedded initialRange="all" />
        </div>
      )}
    </div>
  );
}

/** The campaign's offer change in flight or live (GET /offer-changes). */
export type OfferChangeChip = { status: string; offerText: string | null; endsAt: string | null };

/** "Making your new offer" / "Waiting for Google" / "Offer live until …". */
export function offerChipText(ch: OfferChangeChip): string | null {
  switch (ch.status) {
    case "rendering":
      return "Making your new offer ad";
    case "preview":
      return "New offer ready to check";
    case "awaiting_payment":
      return "New offer waiting for payment";
    case "publishing":
    case "pending_google":
      return "New offer waiting for Google's approval";
    case "live":
      return ch.endsAt ? `Offer live until ${formatDate(ch.endsAt)}, then back to your regular ad` : "Offer live";
    default:
      return null;
  }
}

export function CampaignCard({
  campaign: c,
  stats,
  offerChange,
  whatsapp,
}: {
  campaign: Campaign;
  /** From GET /campaigns/stats; undefined while loading or not launched. */
  stats: CampaignStats | undefined;
  offerChange?: OfferChangeChip;
  /** /auth/me `whatsapp`: the "WhatsApp your new offer" line when it answers them. */
  whatsapp?: WhatsAppState;
}) {
  const chip = offerChange ? offerChipText(offerChange) : null;
  const launched = isLaunched(c);
  const actions = actionsFor(c, stats);
  const page = `/dashboard/campaigns/${c.id}`;
  return (
    // No link wraps the card: the title and the buttons are separate links,
    // so a button tap never also opens the card (no nested interactive elements).
    <Card className="transition-colors hover:border-white/20">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <CardTitle>
            <Link href={page} className="hover:underline hover:underline-offset-4">
              {c.name}
            </Link>
          </CardTitle>
          <CardDescription>
            {c.targetAddress
              ? `${c.radiusMiles} miles around a listing`
              : `${c.targetZipCodes.length} ZIP${c.targetZipCodes.length === 1 ? "" : "s"} within ${c.radiusMiles} miles`}{" "}
            &middot; created {formatDate(c.createdAt)}
          </CardDescription>
        </div>
        <Badge tone={STATUS_TONE[c.status]}>{STATUS_LABEL[c.status]}</Badge>
      </div>
      {chip && <p className="mt-3 break-words text-sm text-amber-200">{chip}</p>}
      {launched && <WhatsAppOfferLine state={whatsapp} />}
      {launched && <StatsSummary campaignId={c.id} stats={stats} />}
      {/* Full-width stack on narrow phones, a wrapping row from 400px up. */}
      <div className="mt-4 flex flex-col gap-2 min-[400px]:flex-row min-[400px]:flex-wrap">
        {actions.map((a, i) => (
          <Link
            key={a.label}
            href={a.href}
            className={cn(buttonVariants({ variant: i === 0 ? "default" : "outline", size: "sm" }))}
          >
            {a.label}
          </Link>
        ))}
      </div>
    </Card>
  );
}

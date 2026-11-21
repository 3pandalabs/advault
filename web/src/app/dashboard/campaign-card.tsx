"use client";

import Link from "next/link";
import type { Campaign, CampaignStats, CampaignStatus } from "@/lib/api/browser";
import { AUDIENCE_FILTERS_ENABLED } from "@/lib/audience";
import { Badge, Card, CardDescription, CardTitle } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatDate, formatRelative } from "@/lib/utils";

// One campaign on the dashboard list (2026-11-20): status, a stats row once
// the ad has launched, and action buttons that deep-link into the campaign
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

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-zinc-500">{label}</dt>
      <dd className="text-sm font-semibold tabular-nums text-zinc-100">{value}</dd>
    </div>
  );
}

function StatsRow({ stats }: { stats: CampaignStats | undefined }) {
  // Still loading, or the stats call failed: say nothing rather than zeros.
  if (!stats) return null;
  const t = stats.totals;
  if (!t || t.impressions === 0) {
    return (
      <p className="mt-4 border-t border-white/10 pt-3 text-xs text-zinc-400">
        Waiting for Google&apos;s first numbers (usually within a day of launch).
      </p>
    );
  }
  return (
    <div className="mt-4 border-t border-white/10 pt-3">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
        <Stat label="Times shown" value={count.format(t.impressions)} />
        <Stat label="Views" value={count.format(t.views)} />
        <Stat label="Clicks" value={count.format(t.clicks)} />
        <Stat label="Spent" value={t.spendDisplay} />
      </dl>
      <p className="mt-2 text-xs text-zinc-500">
        Since launch
        {stats.lastSyncedAt && <> &middot; Updated {formatRelative(stats.lastSyncedAt)}</>} &middot; Google
        reports lag a few hours
      </p>
    </div>
  );
}

export function CampaignCard({
  campaign: c,
  stats,
}: {
  campaign: Campaign;
  /** From GET /campaigns/stats; undefined while loading or not launched. */
  stats: CampaignStats | undefined;
}) {
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
      {launched && <StatsRow stats={stats} />}
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

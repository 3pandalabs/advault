"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import type { Campaign, CampaignStats, CampaignStatus } from "@/lib/api/browser";
import { AUDIENCE_FILTERS_ENABLED } from "@/lib/audience";
import { Badge, Card, CardDescription, CardTitle } from "@/components/ui/card";
import { formatDate, formatRelative } from "@/lib/utils";

// One campaign on the dashboard list (2026-11-20): status, a stats row once
// the ad has launched, and a Manage menu that deep-links into the campaign
// page's own editors (never a copy of them). Every campaign here is the
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
  // Same rule as the campaign page's "Who should see it" card.
  if (AUDIENCE_FILTERS_ENABLED || c.audienceFilters || c.googleCampaignResourceName) {
    out.push({ label: "Change audience", href: `${page}?edit=audience#audience` });
  }
  // The AdVault ad budget pays: top up on the campaign page (checkout comes
  // back to it). Launched on the customer's own Google billing: nothing of
  // ours to top up. Not launched yet: the Balance page.
  if (stats?.walletPays) {
    out.push({ label: "Top up ad budget", href: `${page}#ad-budget` });
  } else if (!c.googleCampaignResourceName) {
    out.push({ label: "Top up ad budget", href: "/dashboard/wallet" });
  }
  return out;
}

function ManageMenu({ campaign, actions }: { campaign: Campaign; actions: Action[] }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const items = useRef<(HTMLAnchorElement | null)[]>([]);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    items.current[0]?.focus();
    const onDown = (e: PointerEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  function onMenuKey(e: React.KeyboardEvent) {
    const list = items.current.filter(Boolean) as HTMLAnchorElement[];
    const i = list.indexOf(document.activeElement as HTMLAnchorElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = e.key === "ArrowDown" ? (i + 1) % list.length : (i - 1 + list.length) % list.length;
      list[next]?.focus();
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      list[e.key === "Home" ? 0 : list.length - 1]?.focus();
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      button.current?.focus();
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  }

  return (
    <div ref={wrap} className="relative z-10">
      <button
        ref={button}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`Manage ${campaign.name}`}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className="inline-flex min-h-9 items-center gap-1 rounded-lg border border-white/15 px-3 py-1.5 text-sm text-zinc-200 hover:border-white/30 hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-amber-400"
      >
        Manage
        <span aria-hidden className={`text-zinc-400 transition ${open ? "rotate-180" : ""}`}>
          ▾
        </span>
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label={`Manage ${campaign.name}`}
          onKeyDown={onMenuKey}
          className="absolute right-0 mt-1 w-52 overflow-hidden rounded-xl border border-white/15 bg-zinc-900 py-1 shadow-xl"
        >
          {actions.map((a, i) => (
            <Link
              key={a.label}
              ref={(el) => {
                items.current[i] = el;
              }}
              href={a.href}
              role="menuitem"
              tabIndex={-1}
              onClick={() => setOpen(false)}
              className="block px-4 py-2.5 text-sm text-zinc-200 hover:bg-white/10 focus:bg-white/10 focus:outline-none"
            >
              {a.label}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
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
  return (
    // The title link stretches over the whole card (after:inset-0), so the
    // card stays one big tap target while the Manage menu sits above it.
    <Card className="relative transition-colors hover:border-white/20 hover:bg-white/[0.05]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <CardTitle>
            <Link
              href={`/dashboard/campaigns/${c.id}`}
              className="after:absolute after:inset-0 after:rounded-xl focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-amber-400"
            >
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
        <div className="flex items-center gap-2">
          <Badge tone={STATUS_TONE[c.status]}>{STATUS_LABEL[c.status]}</Badge>
          <ManageMenu campaign={c} actions={actionsFor(c, stats)} />
        </div>
      </div>
      {launched && <StatsRow stats={stats} />}
    </Card>
  );
}

"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { listCampaigns, type Campaign, type CampaignStatus } from "@/lib/api/browser";
import { Badge, Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatDate, formatMoney } from "@/lib/utils";

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

export default function CampaignsPage() {
  const [campaigns, setCampaigns] = useState<Campaign[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    listCampaigns().then(setCampaigns).catch(() => setError(true));
  }, []);

  if (error) {
    return <p className="text-sm text-red-300">Could not load your campaigns. Please reload.</p>;
  }
  if (!campaigns) {
    return <p className="text-sm text-zinc-500">Loading…</p>;
  }

  // The empty state offers the action, rather than describing it. A dashboard
  // that says "create your first campaign" with no button is a dead end, and
  // only a real signup finds it — which is exactly how the org's launch
  // checklist says to catch this.
  if (campaigns.length === 0) {
    return (
      <Card className="text-center">
        <CardTitle>No campaigns yet</CardTitle>
        <CardDescription>
          Upload a few photos, choose the ZIP codes you serve, and set a daily budget. It takes
          about three minutes.
        </CardDescription>
        <div className="mt-5">
          <Link href="/dashboard/campaigns/new">
            <Button>Create your first campaign</Button>
          </Link>
        </div>
      </Card>
    );
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Campaigns</h1>
        <Link href="/dashboard/campaigns/new">
          <Button>New campaign</Button>
        </Link>
      </div>

      <div className="space-y-3">
        {campaigns.map((c) => (
          <Link key={c.id} href={`/dashboard/campaigns/${c.id}`} className="block">
            <Card className="transition-colors hover:border-white/20 hover:bg-white/[0.05]">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <CardTitle>{c.name}</CardTitle>
                  <CardDescription>
                    {formatMoney(c.dailyBudgetCents, c.currencyCode)}/day &middot;{" "}
                    {c.targetZipCodes.length} ZIP{c.targetZipCodes.length === 1 ? "" : "s"} within{" "}
                    {c.radiusMiles} miles &middot; created {formatDate(c.createdAt)}
                  </CardDescription>
                </div>
                <Badge tone={STATUS_TONE[c.status]}>{STATUS_LABEL[c.status]}</Badge>
              </div>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}

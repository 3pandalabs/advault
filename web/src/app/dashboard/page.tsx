"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { siteVaultSlug } from "@/lib/sitevault";
import { getMe, getSubscription, getWallet, listCampaigns, type Campaign, type CampaignStatus, type Wallet } from "@/lib/api/browser";
import { BudgetBanner } from "@/components/BudgetBanner";
import { CostSimulator } from "@/components/CostSimulator";
import { Badge, Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/utils";

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
  // Shared 3PandaLabs account: someone who came from SiteVault (or has a
  // SiteVault website) gets a link back to it from the empty state.
  const [usesSitevault, setUsesSitevault] = useState(false);
  const router = useRouter();
  // Low / ran-out ad budget banner (top-up-first model).
  const [wallet, setWallet] = useState<Wallet | null>(null);

  // The cost simulator says "$0 today" for the plan only while the account
  // still has its included first month.
  const [firstMonthIncluded, setFirstMonthIncluded] = useState(true);
  useEffect(() => {
    getSubscription()
      .then((s) => setFirstMonthIncluded(s.plan?.firstMonthAvailable !== false))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    getWallet().then(setWallet).catch(() => setWallet(null));
  }, []);

  useEffect(() => {
    getMe()
      .then((me) => setUsesSitevault(Boolean(me.usesSitevault || me.signupApp === "sitevault")))
      .catch(() => setUsesSitevault(false));
  }, []);

  useEffect(() => {
    listCampaigns()
      .then((list) => {
        // Offer combo deep link from SiteVault's edit page
        // (/dashboard?siteOffer=<slug>): the campaign using that site goes
        // straight to its buy-a-new-ad step with the website box ticked. No
        // match (or a renamed site we haven't followed yet) = the dashboard.
        const slug = new URLSearchParams(window.location.search).get("siteOffer");
        // Several campaigns can share the account's one site: prefer one that
        // isn't live, since a live campaign can't buy a new version.
        const matches = slug ? list.filter((c) => siteVaultSlug(c.landingUrl) === slug) : [];
        const match = matches.find((c) => c.status !== "live") ?? matches[0];
        if (match) {
          router.replace(`/dashboard/campaigns/${match.id}?siteOffer=1`);
          return;
        }
        setCampaigns(list);
      })
      .catch(() => setError(true));
  }, [router]);

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
      <div className="space-y-6">
        <Card className="text-center">
          <CardTitle>No campaigns yet</CardTitle>
          <CardDescription>
            Upload a few photos, choose the ZIP codes you serve, and add an ad budget. It takes
            about three minutes.
          </CardDescription>
          <div className="mt-5">
            <Link href="/dashboard/campaigns/new">
              <Button>Create your first campaign</Button>
            </Link>
          </div>
          {usesSitevault ? (
            <p className="mt-5 text-sm text-zinc-400">
              You already have a website.{" "}
              <Link href="/dashboard/website" className="text-sky-300 underline underline-offset-4">
                Go to your website
              </Link>
            </p>
          ) : null}
        </Card>
        <CostSimulator
          ctaHref="/dashboard/campaigns/new"
          addMoreHref="/dashboard/wallet"
          firstMonthIncluded={firstMonthIncluded}
        />
      </div>
    );
  }

  return (
    <div>
      <BudgetBanner
        wallet={wallet}
        href={
          wallet?.budget?.pausedForFunds[0]
            ? `/dashboard/campaigns/${wallet.budget.pausedForFunds[0].id}#ad-budget`
            : wallet?.budget?.liveCampaignIds[0]
              ? `/dashboard/campaigns/${wallet.budget.liveCampaignIds[0]}#ad-budget`
              : "/dashboard/wallet"
        }
      />
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Campaigns</h1>
        <Link href="/dashboard/campaigns/new">
          <Button>New campaign</Button>
        </Link>
      </div>

      <details className="group mb-6 rounded-2xl border border-white/10 bg-white/[0.03]">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-4 text-sm font-medium text-zinc-200 [&::-webkit-details-marker]:hidden">
          What will this cost?
          <span aria-hidden className="text-zinc-400 transition group-open:rotate-180">
            ▾
          </span>
        </summary>
        <div className="border-t border-white/10 px-5 pt-4 pb-5">
          <CostSimulator
            bare
            ctaHref="/dashboard/campaigns/new"
            addMoreHref="/dashboard/wallet"
            firstMonthIncluded={firstMonthIncluded}
          />
        </div>
      </details>

      <div className="space-y-3">
        {campaigns.map((c) => (
          <Link key={c.id} href={`/dashboard/campaigns/${c.id}`} className="block">
            <Card className="transition-colors hover:border-white/20 hover:bg-white/[0.05]">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <CardTitle>{c.name}</CardTitle>
                  <CardDescription>
                    {c.targetAddress
                      ? `${c.radiusMiles} miles around a listing`
                      : `${c.targetZipCodes.length} ZIP${c.targetZipCodes.length === 1 ? "" : "s"} within ${c.radiusMiles} miles`}{" "}
                    &middot; created {formatDate(c.createdAt)}
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

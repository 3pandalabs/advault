"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { siteVaultSlug } from "@/lib/sitevault";
import {
  getCampaignStats,
  getMe,
  getSubscription,
  getWallet,
  listCampaigns,
  type Campaign,
  type CampaignStats,
  type Wallet,
} from "@/lib/api/browser";
import { BudgetBanner } from "@/components/BudgetBanner";
import { CostSimulator } from "@/components/CostSimulator";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CampaignCard, isLaunched } from "./campaign-card";

export default function CampaignsPage() {
  const [campaigns, setCampaigns] = useState<Campaign[] | null>(null);
  const [error, setError] = useState(false);
  // Shared 3PandaLabs account: someone who came from SiteVault (or has a
  // SiteVault website) gets a link back to it from the empty state.
  const [usesSitevault, setUsesSitevault] = useState(false);
  const router = useRouter();
  // Low / ran-out ad budget banner (top-up-first model).
  const [wallet, setWallet] = useState<Wallet | null>(null);
  // Stats row per launched campaign, one call for the whole list
  // (GET /campaigns/stats). null = loading or failed: cards show no row.
  const [stats, setStats] = useState<Map<string, CampaignStats> | null>(null);

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
        if (list.some(isLaunched)) {
          getCampaignStats()
            .then((r) => setStats(new Map(r.campaigns.map((c) => [c.campaignId, c]))))
            .catch(() => setStats(null));
        }
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

      <div className="space-y-3">
        {campaigns.map((c) => (
          <CampaignCard key={c.id} campaign={c} stats={stats?.get(c.id)} />
        ))}
      </div>
    </div>
  );
}

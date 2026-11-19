"use client";

import { useState } from "react";
import type { Campaign, Wallet } from "@/lib/api/browser";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { TopUpPicker } from "@/components/TopUpPicker";
import { aboutDays, daysOfBudget, wizardTopupKey } from "@/lib/budget";
import { formatMoney } from "@/lib/utils";

/**
 * "Add to your ad budget" on the campaign page (top-up-first model,
 * 2026-11-19). Shown for campaigns the AdVault wallet pays for. The ad runs
 * always on at its daily budget until the budget runs out; a top-up restarts
 * one the empty budget paused (api lib/billing/resume.ts).
 */
export function AdBudgetCard({ campaign, wallet }: { campaign: Campaign; wallet: Wallet | null }) {
  // Read once on the client; the card only renders after the wallet loads.
  const [wizardPick] = useState<number | undefined>(() => {
    try {
      const v = Number(typeof window === "undefined" ? 0 : sessionStorage.getItem(wizardTopupKey(campaign.id)));
      return Number.isFinite(v) && v > 0 ? v : undefined;
    } catch {
      return undefined; // storage blocked: the default preset is fine
    }
  });

  if (!wallet) return null;
  const daily = campaign.dailyBudgetCents;
  const balance = wallet.balanceMinor;
  // Live: the shared budget is split across every live campaign.
  const liveDaily = wallet.budget?.liveCampaignIds.includes(campaign.id) ? wallet.budget.liveDailyMinor : daily;
  const days = daysOfBudget(balance, liveDaily);

  return (
    <Card className="mt-2 mb-4" id="ad-budget">
      <CardTitle>Your ad budget</CardTitle>
      <p className="mt-2 text-3xl font-semibold">{formatMoney(balance, wallet.currencyCode)}</p>
      <CardDescription className="mt-1">
        {balance > 0
          ? `Lasts ${aboutDays(days)} at ${formatMoney(liveDaily, wallet.currencyCode)} a day.`
          : `Your ad runs at ${formatMoney(daily, wallet.currencyCode)} a day until your budget runs out.`}{" "}
        You only pay for what Google delivers. Unused budget stays in your account.
      </CardDescription>
      <p className="mt-4 text-sm font-medium text-zinc-200">Add to your ad budget</p>
      <div className="mt-2">
        <TopUpPicker
          currency={wallet.currencyCode}
          dailyCents={liveDaily}
          balanceCents={balance}
          campaignId={campaign.id}
          value={wizardPick}
        />
      </div>
    </Card>
  );
}

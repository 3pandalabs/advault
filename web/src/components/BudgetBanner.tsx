"use client";

import Link from "next/link";
import type { Wallet } from "@/lib/api/browser";
import { useInAndroidApp } from "@/components/AppPayments";
import { APP_PAYMENTS_MESSAGE } from "@/lib/appPayments";

/**
 * The low / ran-out ad budget banner (top-up-first model, 2026-11-19). State
 * comes from GET /wallet (`budget`), computed live from the balance. AdVault
 * sends customers no email, so this banner IS the low-balance alert.
 *
 * `campaignId` limits it to that campaign (campaign page); without it, any
 * live or paused-for-funds campaign counts (dashboard). `href` is where
 * "Add more" goes.
 */
export function BudgetBanner({
  wallet,
  campaignId,
  href = "/dashboard/wallet",
}: {
  wallet: Wallet | null;
  campaignId?: string;
  href?: string;
}) {
  // TODO(play-billing): in the Android app the banner says where to pay instead of linking to it.
  const inApp = useInAndroidApp();
  const b = wallet?.budget;
  if (!b) return null;
  const addMore = inApp ? (
    <span className="mt-1 block">{APP_PAYMENTS_MESSAGE}</span>
  ) : (
    <Link href={href} className="font-medium underline underline-offset-4">
      Add to my ad budget
    </Link>
  );
  const paused = campaignId ? b.pausedForFunds.some((c) => c.id === campaignId) : b.pausedForFunds.length > 0;
  const live = campaignId ? b.liveCampaignIds.includes(campaignId) : b.liveCampaignIds.length > 0;

  if (paused || (live && b.state === "empty")) {
    return (
      <div className="mb-4 rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2 text-sm text-red-200">
        <strong>Paused — your ad budget ran out.</strong> Add more to restart.{" "}
        {addMore}
      </div>
    );
  }
  if (live && b.state === "low") {
    return (
      <div className="mb-4 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-sm text-amber-200">
        <strong>Your ad budget is running low</strong>
        . Add more to keep your ad running.{" "}
        {addMore}
      </div>
    );
  }
  return null;
}

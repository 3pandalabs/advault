import Link from "next/link";
import type { Campaign, CampaignStatus, Wallet } from "@/lib/api/browser";
import { STATUS_LABEL } from "./campaign-card";

// The strip above the campaign list (2026-11-24): what's left of the ad budget
// and how many campaigns are in each state. Statuses with none are left out.

const ORDER: CampaignStatus[] = ["live", "paused", "ready", "rendering", "draft", "failed"];

const VALUE_TONE: Partial<Record<CampaignStatus, string>> = {
  live: "text-emerald-300",
  failed: "text-red-300",
};

function daysLeftText(wallet: Wallet): string | null {
  const days = wallet.budget?.daysLeft;
  if (typeof days !== "number" || !wallet.budget?.liveCampaignIds.length) return null;
  const n = Math.floor(days);
  return n < 1 ? "Less than a day left" : `About ${n} day${n === 1 ? "" : "s"} left`;
}

export function CampaignsSummary({
  campaigns,
  wallet,
}: {
  campaigns: Campaign[];
  /** null = loading, failed, or the AdVault ad budget pays for none of these. */
  wallet: Wallet | null;
}) {
  const counts = ORDER.map((status) => ({
    status,
    n: campaigns.filter((c) => c.status === status).length,
  })).filter((s) => s.n > 0);
  const daysLeft = wallet ? daysLeftText(wallet) : null;

  return (
    <section
      aria-label="Campaigns summary"
      className="mb-6 flex flex-col gap-4 rounded-xl border border-white/10 bg-white/[0.02] p-4 sm:flex-row sm:items-center sm:justify-between"
    >
      {wallet && (
        <div className="flex items-end justify-between gap-4 sm:block">
          <div>
            <p className="text-xs text-zinc-500">Balance remaining</p>
            <p className="mt-0.5 text-2xl font-semibold tabular-nums text-amber-300">{wallet.display}</p>
            {daysLeft && <p className="text-xs text-zinc-400">{daysLeft}</p>}
          </div>
          <Link
            href="/dashboard/wallet"
            className="text-sm font-medium text-amber-300 underline-offset-4 hover:underline"
          >
            Top up
          </Link>
        </div>
      )}
      <dl className="flex flex-wrap gap-x-6 gap-y-3">
        <div className="flex flex-col-reverse">
          <dt className="text-xs text-zinc-500">{campaigns.length === 1 ? "Campaign" : "Campaigns"}</dt>
          <dd className="text-2xl font-semibold tabular-nums text-zinc-100">{campaigns.length}</dd>
        </div>
        {counts.map(({ status, n }) => (
          <div key={status} className="flex flex-col-reverse">
            <dt className="text-xs text-zinc-500">{STATUS_LABEL[status]}</dt>
            <dd className={`text-2xl font-semibold tabular-nums ${VALUE_TONE[status] ?? "text-zinc-100"}`}>{n}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

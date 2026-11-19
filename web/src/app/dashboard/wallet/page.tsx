"use client";

import { useEffect, useState } from "react";
import { getWallet, type Wallet } from "@/lib/api/browser";
import { Badge, Card, CardDescription, CardTitle } from "@/components/ui/card";
import { BudgetBanner } from "@/components/BudgetBanner";
import { TopUpPicker } from "@/components/TopUpPicker";
import { MONTHLY_RECHARGE_LINE } from "@/lib/prices";
import { ADD_MORE_LINE } from "@/lib/spread";
import { formatDate } from "@/lib/utils";

// The ad balance. Under the managed (MCC) model, ads run against 3PandaLabs'
// billing and this balance is what the advertiser has actually paid in — so it
// is also the hard cap on their spend. The copy says that plainly rather than
// treating it as an implementation detail: "your ads stop when it runs out" is
// a feature to a small business, not a limitation.

function fmt(minor: number, currency: string) {
  return new Intl.NumberFormat(currency === "INR" ? "en-IN" : "en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: minor % 100 === 0 ? 0 : 2,
  }).format(minor / 100);
}

const LABELS: Record<string, string> = {
  topup: "Top-up",
  spend: "Ad spend",
  fee: "Platform fee",
  refund: "Refund",
  adjustment: "Adjustment",
};

export default function WalletPage() {
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () =>
    getWallet()
      .then(setWallet)
      .catch(() => setError("Could not load your balance."));

  useEffect(() => {
    refresh();
  }, []);

  if (error && !wallet) return <p className="text-sm text-red-300">{error}</p>;
  if (!wallet) return <p className="text-sm text-zinc-500">Loading…</p>;

  const empty = wallet.balanceMinor <= 0;
  const budget = wallet.budget;
  const returned = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("status") === "success";

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Ad budget</h1>

      <div className="mt-4">
        <BudgetBanner wallet={wallet} href="#add" />
      </div>
      {returned && (
        <p className="mt-4 rounded-lg border border-emerald-400/30 bg-emerald-400/10 px-3 py-2 text-sm text-emerald-200">
          Thanks — your payment went through. It can take a minute to show here.
        </p>
      )}

      {error && (
        <p className="mt-4 rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2 text-sm text-red-200">
          {error}
        </p>
      )}

      <Card className="mt-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs tracking-wide text-zinc-500 uppercase">Available</p>
            <p className="mt-1 text-4xl font-semibold">{wallet.display}</p>
          </div>
          {budget?.state === "empty" ? (
            <Badge tone="danger">Ad paused</Badge>
          ) : budget?.state === "low" ? (
            <Badge tone="pending">Running low</Badge>
          ) : empty ? (
            <Badge tone="neutral">Empty</Badge>
          ) : (
            <Badge tone="success">Funded</Badge>
          )}
        </div>

        <CardDescription className="mt-4">
          Your ad runs until this runs out. You only pay for
          what Google delivers, and you can never be charged more than you added. Unused
          budget stays here for your next ad, and if you leave we refund it.
        </CardDescription>
      </Card>

      <Card className="mt-4" id="add">
        <CardTitle>Add to your ad budget</CardTitle>
        <CardDescription className="mt-1">
          {MONTHLY_RECHARGE_LINE} {ADD_MORE_LINE} More budget means more days of showing.
        </CardDescription>
        <div className="mt-4">
          <TopUpPicker
            currency={wallet.currencyCode}
          />
        </div>
      </Card>

      <h2 className="mt-8 mb-3 text-lg font-semibold">Activity</h2>
      {wallet.entries.length === 0 ? (
        <Card>
          <CardTitle>Nothing yet</CardTitle>
          <CardDescription>
            Add to your ad budget to launch your first ad. Every dollar in and out shows up here.
          </CardDescription>
        </Card>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-white/10">
          <table className="w-full text-sm">
            <thead className="bg-white/[0.03] text-left text-xs tracking-wide text-zinc-500 uppercase">
              <tr>
                <th className="px-4 py-3">Date</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">Detail</th>
                <th className="px-4 py-3 text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {wallet.entries.map((e) => (
                <tr key={e.id} className="border-t border-white/5">
                  <td className="px-4 py-3 whitespace-nowrap text-zinc-400">
                    {formatDate(e.createdAt)}
                  </td>
                  <td className="px-4 py-3">{LABELS[e.type] ?? e.type}</td>
                  <td className="px-4 py-3 text-zinc-400">{e.description ?? "—"}</td>
                  <td
                    className={`px-4 py-3 text-right font-medium whitespace-nowrap ${
                      e.amountMinor > 0 ? "text-emerald-300" : "text-zinc-200"
                    }`}
                  >
                    {e.amountMinor > 0 ? "+" : "−"}
                    {fmt(Math.abs(e.amountMinor), e.currencyCode)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

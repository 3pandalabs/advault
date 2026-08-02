"use client";

import { useEffect, useState } from "react";
import { ApiError, getWallet, topUp, type Wallet } from "@/lib/api/browser";
import { Badge, Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/utils";

// The ad balance. Under the managed (MCC) model, ads run against 3PandaLabs'
// billing and this balance is what the advertiser has actually paid in — so it
// is also the hard cap on their spend. The copy says that plainly rather than
// treating it as an implementation detail: "your ads stop when it runs out" is
// a feature to a small business, not a limitation.

const PRESETS: Record<string, number[]> = {
  INR: [200_000, 500_000, 1_000_000],
  USD: [10_000, 25_000, 50_000],
};

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
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = () =>
    getWallet()
      .then(setWallet)
      .catch(() => setError("Could not load your balance."));

  useEffect(() => {
    refresh();
  }, []);

  async function onTopUp(amountMinor: number) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const session = await topUp(amountMinor);

      if (session.redirectUrl) {
        window.location.assign(session.redirectUrl);
        return;
      }

      // No redirect. Either a client-side widget (Razorpay) or the manual
      // provider, which means no payment vendor is configured for this
      // currency. Say so instead of leaving a button that appears to do
      // nothing — a silent no-op on a payment screen is the worst outcome.
      const payload = session.clientPayload as { manual?: boolean; message?: string };
      setNotice(
        payload.manual
          ? (payload.message ?? "Payment is not available yet. Please contact support.")
          : "Opening checkout…",
      );
      await refresh();
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === "checkout_failed"
          ? "Could not start checkout. Please try again."
          : "Something went wrong starting your top-up.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (error && !wallet) return <p className="text-sm text-red-300">{error}</p>;
  if (!wallet) return <p className="text-sm text-zinc-500">Loading…</p>;

  const presets = PRESETS[wallet.currencyCode] ?? PRESETS.USD;
  const empty = wallet.balanceMinor <= 0;

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Ad balance</h1>

      {error && (
        <p className="mt-4 rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2 text-sm text-red-200">
          {error}
        </p>
      )}
      {notice && (
        <p className="mt-4 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-sm text-amber-200">
          {notice}
        </p>
      )}

      <Card className="mt-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs tracking-wide text-zinc-500 uppercase">Available</p>
            <p className="mt-1 text-4xl font-semibold">{wallet.display}</p>
          </div>
          {empty ? (
            <Badge tone="danger">Campaigns paused</Badge>
          ) : (
            <Badge tone="success">Funded</Badge>
          )}
        </div>

        <CardDescription className="mt-4">
          Your ads run against this balance and stop when it is empty — you can never be
          charged more than you have topped up. We add a little headroom before letting a
          campaign go live so it does not stop mid-day.
        </CardDescription>

        <div className="mt-5 flex flex-wrap gap-2">
          {presets.map((p) => (
            <Button key={p} variant="outline" disabled={busy} onClick={() => onTopUp(p)}>
              Add {fmt(p, wallet.currencyCode)}
            </Button>
          ))}
        </div>
      </Card>

      <h2 className="mt-8 mb-3 text-lg font-semibold">Activity</h2>
      {wallet.entries.length === 0 ? (
        <Card>
          <CardTitle>Nothing yet</CardTitle>
          <CardDescription>
            Top up to launch your first campaign. Every rupee in and out shows up here.
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

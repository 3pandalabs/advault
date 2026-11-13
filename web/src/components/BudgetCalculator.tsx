"use client";

import { useEffect, useState } from "react";
import { API_URL } from "@/lib/api/browser";
import { Button } from "@/components/ui/button";
import Link from "next/link";

// The micro-budget calculator. Top of the funnel, so it works signed-out and
// hits the public /pricing/estimate route.
//
// It computes nothing locally. Every number comes from the API, because the
// launch guard, the checkout and this widget must agree — a copy of the pricing
// maths in the browser is a copy that drifts, and the one that drifts is always
// the one the customer saw.

type Estimate = {
  currency: "INR" | "USD";
  adBudgetMinor: number;
  monthlyFeeMinor: number;
  monthlyTotalMinor: number;
  reach: { low: number; high: number };
  newAdMinor: number | null;
  display: { adBudget: string; monthlyFee: string; monthlyTotal: string; newAd: string | null };
};

// US only for now (India pricing returns when India launches). $30 / $90 /
// $150 a month = $1 / $3 / $5 a day on Keep it running.
const PRESETS = [3_000, 9_000, 15_000];

function fmt(n: number) {
  return new Intl.NumberFormat("en-US").format(n);
}

export function BudgetCalculator() {
  const currency = "USD";
  const [budget, setBudget] = useState(PRESETS[0]);
  const [est, setEst] = useState<Estimate | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const q = new URLSearchParams({
      currency,
      adBudgetMinor: String(budget),
    });
    fetch(`${API_URL}/pricing/estimate?${q}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => !cancelled && (setEst(d), setFailed(false)))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [budget]);

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6 backdrop-blur-sm">
      <h3 className="text-lg font-semibold">How many views does my budget buy?</h3>

      <p className="mt-2 text-sm text-zinc-400">
        Pick a monthly ad budget. We&apos;ll show what it reaches in your neighborhood.
 More budget means more views; your ad price stays the same.
      </p>

      <div className="mt-5 flex flex-wrap gap-2">
        {PRESETS.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setBudget(p)}
            className={
              budget === p
                ? "rounded-lg border border-amber-400 bg-amber-400/10 px-4 py-2 text-sm font-medium text-amber-200"
                : "rounded-lg border border-white/15 px-4 py-2 text-sm text-zinc-300 hover:bg-white/5"
            }
          >
            {new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 0 }).format(
              p / 100,
            )}
            /mo
          </button>
        ))}
      </div>


      {failed ? (
        <p className="mt-5 text-sm text-zinc-500">
          Couldn&apos;t load pricing just now. It&apos;s on the signup page too.
        </p>
      ) : est ? (
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
            <p className="text-xs tracking-wide text-zinc-500 uppercase">Estimated monthly reach</p>
            <p className="mt-1 text-3xl font-semibold text-amber-300">
              {fmt(est.reach.low)}–{fmt(est.reach.high)}
            </p>
            <p className="mt-1 text-sm text-zinc-400">views near your business</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
            <p className="text-xs tracking-wide text-zinc-500 uppercase">You pay monthly</p>
            <p className="mt-1 text-3xl font-semibold">{est.display.monthlyTotal}</p>
            <p className="mt-1 text-sm text-zinc-400">
              {/* Quoted as one all-in figure on purpose. Showing the fee beside
                  the ad budget invites the fee-ratio comparison against an
                  agency retainer, which a flat fee on a small budget never
                  wins — and the customer is buying the whole thing existing,
                  not media buying by the hour. */}
              {est.monthlyFeeMinor > 0
                ? `${est.display.adBudget} goes to your ads + ${est.display.monthlyFee} AdVault fee`
                : `${est.display.adBudget} ad budget · no platform fee`}
            </p>
            {est.display.newAd && (
              <p className="mt-1 text-sm text-zinc-400">Plus {est.display.newAd} one-time for each ad we make.</p>
            )}
          </div>
        </div>
      ) : (
        <p className="mt-6 text-sm text-zinc-500">Calculating…</p>
      )}

      {/* Said plainly, not buried. These are modelled figures from typical local
          video CPMs — a hard promise about someone's specific neighbourhood is a
          claim we cannot back, and a small business betting rent money on it
          deserves to know that. Same honesty rule as MealMargin's dataset. */}
      <p className="mt-5 text-xs leading-relaxed text-zinc-500">
        Reach is an estimate based on typical CPMs for local video, not a guarantee. Real
        results depend on your area, audience and competition. You keep full control of the
        budget and can stop any time. No contract.
      </p>

      <div className="mt-5">
        <Link href="/signup">
          <Button size="lg">Start with {est?.display.adBudget ?? "a small budget"}</Button>
        </Link>
      </div>
    </div>
  );
}

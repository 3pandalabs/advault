"use client";

import { useEffect, useMemo, useState } from "react";
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
  display: { adBudget: string; monthlyTotal: string };
};

const PRESETS: Record<"INR" | "USD", number[]> = {
  // ₹2,000 / ₹5,000 / ₹10,000
  INR: [200_000, 500_000, 1_000_000],
  // $100 / $250 / $500
  USD: [10_000, 25_000, 50_000],
};

function fmt(n: number) {
  return new Intl.NumberFormat("en-US").format(n);
}

export function BudgetCalculator() {
  const [currency, setCurrency] = useState<"INR" | "USD">("INR");
  // The chosen preset is tracked as an INDEX, not an amount. Switching currency
  // then has to change nothing — the budget is derived — where storing the
  // amount would need an effect to re-sync it, which is a cascading render and
  // the kind of derived-state-in-an-effect the lint rule correctly rejects.
  const [presetIndex, setPresetIndex] = useState(0);
  const [atCost, setAtCost] = useState(false);
  const [est, setEst] = useState<Estimate | null>(null);
  const [failed, setFailed] = useState(false);

  const presets = useMemo(() => PRESETS[currency], [currency]);
  const budget = presets[presetIndex] ?? presets[0];

  useEffect(() => {
    let cancelled = false;
    const q = new URLSearchParams({
      currency,
      adBudgetMinor: String(budget),
      marginMode: atCost ? "at_cost" : "standard",
    });
    fetch(`${API_URL}/pricing/estimate?${q}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => !cancelled && (setEst(d), setFailed(false)))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [currency, budget, atCost]);

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6 backdrop-blur-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-lg font-semibold">What does ₹2,000 actually buy?</h3>
        <div className="flex rounded-lg border border-white/15 p-0.5 text-sm">
          {(["INR", "USD"] as const).map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setCurrency(c)}
              className={
                currency === c
                  ? "rounded-md bg-amber-400 px-3 py-1 font-medium text-zinc-950"
                  : "rounded-md px-3 py-1 text-zinc-400 hover:text-zinc-200"
              }
            >
              {c === "INR" ? "🇮🇳 INR" : "🇺🇸 USD"}
            </button>
          ))}
        </div>
      </div>

      <p className="mt-2 text-sm text-zinc-400">
        Pick a monthly ad budget. We&apos;ll show what it reaches in your neighbourhood.
      </p>

      <div className="mt-5 flex flex-wrap gap-2">
        {presets.map((p, i) => (
          <button
            key={p}
            type="button"
            onClick={() => setPresetIndex(i)}
            className={
              budget === p
                ? "rounded-lg border border-amber-400 bg-amber-400/10 px-4 py-2 text-sm font-medium text-amber-200"
                : "rounded-lg border border-white/15 px-4 py-2 text-sm text-zinc-300 hover:bg-white/5"
            }
          >
            {new Intl.NumberFormat(currency === "INR" ? "en-IN" : "en-US", {
              style: "currency",
              currency,
              maximumFractionDigits: 0,
            }).format(p / 100)}
          </button>
        ))}
      </div>

      <label className="mt-4 flex cursor-pointer items-center gap-2 text-sm text-zinc-400">
        <input
          type="checkbox"
          className="accent-amber-400"
          checked={atCost}
          onChange={(e) => setAtCost(e.target.checked)}
        />
        At-cost mode — you pay exactly what Google charges, no platform fee
      </label>

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
                ? `${est.display.adBudget} of ads, everything handled`
                : `${est.display.adBudget} ad budget · no platform fee`}
            </p>
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
        budget and can stop any time.
      </p>

      <div className="mt-5">
        <Link href="/signup">
          <Button size="lg">Start with {est?.display.adBudget ?? "a small budget"}</Button>
        </Link>
      </div>
    </div>
  );
}

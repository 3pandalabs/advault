"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { TopUpPicker } from "@/components/TopUpPicker";
import { timesShownEstimate } from "@/lib/budget";
import {
  MIN_AD_BUDGET_CENTS,
  PLAN_PRICE_CENTS_PER_MONTH,
  WEBSITE_RENEWAL_CENTS_PER_YEAR,
  costToday,
} from "@/lib/prices";
import { formatMoney } from "@/lib/utils";

// "What will this cost?" (owner, 2026-11-19): the ad, the ad budget, the
// optional website and the plan, added up to what is paid today, with the
// estimate of how often the ad is shown. The budget is shown ONLY as times
// shown: never per day, never as views. Prices come from lib/prices.

const CURRENCY = "USD";
const n = (x: number) => x.toLocaleString("en-US");
const money = (c: number) => formatMoney(c, CURRENCY);

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex cursor-pointer items-center gap-2.5 text-sm text-zinc-200">
      <input
        type="checkbox"
        className="size-4 shrink-0 accent-amber-400"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}

function Line({ label, amount, note }: { label: string; amount: string; note?: React.ReactNode }) {
  return (
    <li className="flex items-baseline justify-between gap-3 py-2">
      <span className="min-w-0">
        <span className="text-zinc-200">{label}</span>
        {note ? <span className="block text-xs text-zinc-400">{note}</span> : null}
      </span>
      <span className="shrink-0 font-medium tabular-nums text-zinc-100">{amount}</span>
    </li>
  );
}

export function CostSimulator({
  ctaHref,
  ctaPrefix = "Start with",
  firstMonthIncluded = true,
  title = "What will this cost?",
  bare = false,
}: {
  ctaHref: string;
  /** The button reads "<prefix> $X" with X = pay today. */
  ctaPrefix?: string;
  /** False once the account has used its included first month of the plan. */
  firstMonthIncluded?: boolean;
  title?: string;
  /** No card border or title, for use inside another card. */
  bare?: boolean;
}) {
  const [budget, setBudget] = useState(MIN_AD_BUDGET_CENTS);
  const [ownVideo, setOwnVideo] = useState(false);
  const [website, setWebsite] = useState(false);

  const cost = costToday({ adBudgetCents: budget, ownVideo, website, firstMonthIncluded });
  const est = timesShownEstimate(budget, CURRENCY);
  const plan = money(PLAN_PRICE_CENTS_PER_MONTH);

  const body = (
    <>
      {!bare && (
        <>
          <h3 className="text-lg font-semibold">{title}</h3>
          <p className="mt-2 text-sm text-zinc-400">Pick an ad budget and see exactly what you pay.</p>
        </>
      )}

      <div className={bare ? "" : "mt-5"}>
        <p className="mb-2 text-sm font-medium text-zinc-300">Ad budget</p>
        <TopUpPicker mode="choose" currency={CURRENCY} value={budget} onChange={setBudget} showEstimate={false} />
      </div>

      <div className="mt-4 space-y-2">
        <Toggle checked={ownVideo} onChange={setOwnVideo} label="I'll upload my own video" />
        <Toggle checked={website} onChange={setWebsite} label="Also make me a website" />
      </div>

      <div className="mt-5 rounded-xl border border-dashed border-white/15 bg-black/20 px-4 py-2">
        <ul className="divide-y divide-white/10 text-sm">
          <Line
            label="Your ad"
            amount={money(cost.adCents)}
            note={ownVideo ? "Your own video: no fee" : "One-time, per ad"}
          />
          <Line label="Ad budget" amount={money(cost.adBudgetCents)} note="Goes 100% to Google" />
          {website && (
            <Line
              label="Website"
              amount={money(cost.websiteCents)}
              note={`First year of Pro included, then ${money(WEBSITE_RENEWAL_CENTS_PER_YEAR)}/year`}
            />
          )}
          <Line
            label="AdVault plan"
            amount={`${money(cost.planTodayCents)} today`}
            note={
              firstMonthIncluded
                ? `First month included, then ${plan}/month while your ad runs`
                : `Then ${plan}/month while your ad runs`
            }
          />
        </ul>
        <div className="flex items-baseline justify-between gap-3 border-t border-white/20 py-3">
          <span className="font-semibold">Pay today</span>
          <span key={cost.totalTodayCents} className="estimate-flash text-xl font-bold tabular-nums">
            {money(cost.totalTodayCents)}
          </span>
        </div>
      </div>

      <p className="mt-4 text-base text-zinc-200">
        Your ad would be shown about{" "}
        <span key={budget} className="estimate-flash font-semibold text-amber-300">
          {n(est.low)}–{n(est.high)}
        </span>{" "}
        times to people near you.
      </p>
      <p className="mt-2 text-sm text-zinc-400">
        Next month, if your ad keeps running: {plan} plan + any ad budget you add.
      </p>

      {/* Modelled from typical local video CPMs, not a promise about a
          specific neighbourhood. Said plainly. */}
      <p className="mt-4 text-xs leading-relaxed text-zinc-500">
        This is an estimate based on typical costs for local video ads, not a guarantee. Real results depend on
        your area, audience and competition. Unused budget stays in your account. No contract.
      </p>

      <div className="mt-5">
        <Link href={ctaHref}>
          <Button size="lg">
            {ctaPrefix} {money(cost.totalTodayCents)}
          </Button>
        </Link>
      </div>
    </>
  );

  if (bare) return <div>{body}</div>;
  return <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 backdrop-blur-sm sm:p-6">{body}</div>;
}

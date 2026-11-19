"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { TopUpPicker } from "@/components/TopUpPicker";
import { timesShownEstimate } from "@/lib/budget";
import { MIN_AD_BUDGET_CENTS, monthlyBreakdown } from "@/lib/prices";
import { formatMoney } from "@/lib/utils";

// "What will this cost?" (owner, 2026-11-19, "from $55 a month"): month one
// (the ad, the website, the plan's included first month and the chosen ad
// budget) next to every month after (the plan + the SAME chosen budget,
// recharged automatically: $35 -> $55, $100 -> $120), or "Nothing more" for
// "Just this once" (no plan, no recharge; the ad stops when the budget runs
// out). With how often the ad is shown and the honest timing: Google's
// $5-a-day minimum means $35 covers about 6 days of showing, about 2 days a
// week for most of the month (lib/spread). The budget is never shown as a
// daily price and never as views. Prices come from lib/prices.

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

function Line({ label, amount, note, flash }: { label: string; amount: string; note?: React.ReactNode; flash?: boolean }) {
  return (
    <li className="flex items-baseline justify-between gap-3 py-2">
      <span className="min-w-0">
        <span className="text-zinc-200">{label}</span>
        {note ? <span className="block text-xs text-zinc-400">{note}</span> : null}
      </span>
      <span
        key={flash ? amount : undefined}
        className={`shrink-0 font-medium tabular-nums text-zinc-100${flash ? " estimate-flash" : ""}`}
      >
        {amount}
      </span>
    </li>
  );
}

function Choice({ active, onClick, label, sub }: { active: boolean; onClick: () => void; label: string; sub: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`min-w-0 flex-1 rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
        active ? "border-amber-400 bg-amber-400/10 text-zinc-100" : "border-white/15 text-zinc-300 hover:border-white/30"
      }`}
    >
      <span className="block font-medium">{label}</span>
      <span className="block text-xs text-zinc-400">{sub}</span>
    </button>
  );
}

function Column({ title, total, children }: { title: string; total: number; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-white/15 bg-black/20 px-4 py-2">
      <p className="pt-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">{title}</p>
      <ul className="divide-y divide-white/10 text-sm">{children}</ul>
      <div className="flex items-baseline justify-between gap-3 border-t border-white/20 py-3">
        <span className="font-semibold">Total</span>
        <span key={total} className="estimate-flash text-xl font-bold tabular-nums">
          {money(total)}
        </span>
      </div>
    </div>
  );
}

export function CostSimulator({
  ctaHref,
  ctaPrefix = "Start for",
  firstMonthIncluded = true,
  title = "What will this cost?",
  bare = false,
  addMoreHref,
}: {
  ctaHref: string;
  /** The button reads "<prefix> $X" with X = month one's total. */
  ctaPrefix?: string;
  /** False once the account has used its included first month of the plan. */
  firstMonthIncluded?: boolean;
  title?: string;
  /** No card border or title, for use inside another card. */
  bare?: boolean;
  /** Where "Add a one-time top-up anytime" links (logged in); no link when absent. */
  addMoreHref?: string;
}) {
  const [budget, setBudget] = useState(MIN_AD_BUDGET_CENTS);
  // Own-video uploads are paused for customers (CLAUDE.md 2026-11-16), so the
  // "I'll upload my own video" toggle is hidden. Restore it when they reopen.
  const ownVideo = false;
  // On by default: the "from $55 a month" price includes the website.
  const [website, setWebsite] = useState(true);
  // "Every month" (Keep it running, recommended) or "Just this once".
  const [monthly, setMonthly] = useState(true);

  // Every month after = $20 + the SAME chosen budget (the API recharges it).
  const { firstMonth, everyMonth } = monthlyBreakdown({ adBudgetCents: budget, ownVideo, website, firstMonthIncluded });
  const est = timesShownEstimate(budget, CURRENCY);

  const body = (
    <>
      {!bare && (
        <>
          <h3 className="text-lg font-semibold">{title}</h3>
          <p className="mt-2 text-sm text-zinc-400">Pick an ad budget and see exactly what you pay.</p>
        </>
      )}

      <div className={bare ? "" : "mt-5"}>
        <p className="mb-2 text-sm font-medium text-zinc-300">How do you want to pay?</p>
        <div className="flex flex-col gap-2 sm:flex-row" role="group" aria-label="How often">
          <Choice active={monthly} onClick={() => setMonthly(true)} label="Every month" sub="Recommended. Cancel anytime." />
          <Choice active={!monthly} onClick={() => setMonthly(false)} label="Just this once" sub="One payment. No renewals." />
        </div>
      </div>

      <div className="mt-5">
        <p className="mb-2 text-sm font-medium text-zinc-300">{monthly ? "Your monthly ad budget" : "Your ad budget"}</p>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <TopUpPicker mode="choose" currency={CURRENCY} value={budget} onChange={setBudget} showEstimate={false} />
          {/* Same row, right corner: how often the chosen budget is shown.
              Keyed on the budget so it flashes on every price click. */}
          <div
            className="rounded-xl border border-amber-400/40 bg-amber-400/10 px-4 py-2 text-right"
            aria-live="polite"
          >
            <p className="text-[11px] uppercase tracking-wide text-amber-200/80">Shown about</p>
            <p className="text-xl font-semibold text-amber-300 tabular-nums">
              <span key={`box-${budget}`} className="estimate-flash">
                {n(est.low)}–{n(est.high)}
              </span>
            </p>
            <p className="text-[11px] text-zinc-400">times {monthly ? "a month" : "in all"} to people near you</p>
          </div>
        </div>
      </div>

      <div className="mt-4 space-y-2">
        <Toggle checked={website} onChange={setWebsite} label="Also make me a website" />
      </div>


      <p className="mt-6 mb-2 text-sm font-medium text-zinc-300">What you pay</p>
      <div className={`grid gap-3 ${monthly ? "sm:grid-cols-2" : ""}`}>
        <Column title={monthly ? "First month" : "You pay once"} total={firstMonth.totalTodayCents}>
          <Line label="Your ad" amount={money(firstMonth.adCents)} note="Made once" />
          {website && (
            <Line
              label="Your website"
              amount={money(firstMonth.websiteCents)}
              note={monthly ? "Once, then included while your plan runs" : "Once, with a year of Pro"}
            />
          )}
          {monthly && (
            <Line
              label="AdVault plan"
              amount={money(firstMonth.planTodayCents)}
              note={firstMonthIncluded ? "First month included" : undefined}
            />
          )}
          <Line label="Ad budget" amount={money(firstMonth.adBudgetCents)} note="100% to Google" flash />
        </Column>
        {monthly ? (
          <Column title="Every month after" total={everyMonth.totalCents}>
            <Line label="AdVault plan" amount={money(everyMonth.planCents)} note="Only while your ad runs" />
            <Line
              label="Ad budget"
              amount={money(everyMonth.adBudgetCents)}
              note="100% to Google, recharged automatically"
              flash
            />
          </Column>
        ) : null}
      </div>
      <p className="mt-3 text-sm text-zinc-300 sm:text-base">
        {monthly
          ? "Change your monthly ad budget anytime. Want it shown more this month? "
          : "One payment. No renewals. Your ad stops when the budget runs out. Want it shown more? "}
        {addMoreHref ? (
          <Link href={addMoreHref} className="text-amber-300 underline-offset-2 hover:underline">
            Add a one-time top-up anytime.
          </Link>
        ) : (
          "Add a one-time top-up anytime."
        )}
      </p>

      {/* Modelled from typical local video CPMs, not a promise about a
          specific neighbourhood. Said plainly. */}
      <p className="mt-4 text-xs leading-relaxed text-zinc-500">
        This is an estimate based on typical costs for local video ads, not a guarantee. Real results depend on
        your area, audience and competition.{monthly ? " Pause anytime: no fee and no recharge while paused." : ""} Unused
        budget stays in your account. No contract.
      </p>

      <div className="mt-5">
        <Link href={ctaHref}>
          <Button size="lg">
            {ctaPrefix} {money(firstMonth.totalTodayCents)}
          </Button>
        </Link>
      </div>
    </>
  );

  if (bare) return <div>{body}</div>;
  return <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 backdrop-blur-sm sm:p-6">{body}</div>;
}

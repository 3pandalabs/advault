"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ApiError, getSubscription, setMonthlyAdBudget, type SubscriptionView } from "@/lib/api/browser";
import { Button } from "@/components/ui/button";
import { TopUpPicker } from "@/components/TopUpPicker";
import { MONTHLY_AD_BUDGET_CENTS, PLAN_PRICE_CENTS_PER_MONTH } from "@/lib/prices";
import { formatMoney } from "@/lib/utils";

// "From $55 a month" (owner, 2026-11-19): the customer's chosen monthly ad
// budget, recharged automatically with the plan, and a Change control (PUT
// /subscription/ad-budget: from the next monthly payment, nothing charged
// now). "Just this once" accounts see that there is no recharge and how to
// turn Keep it running on. Used on the wallet page and the campaign's ad
// budget card, above the one-time top-up, which stays.

export function MonthlyBudgetCard({ className = "" }: { className?: string }) {
  const [view, setView] = useState<SubscriptionView | null>(null);
  const [editing, setEditing] = useState(false);
  const [pick, setPick] = useState(MONTHLY_AD_BUDGET_CENTS);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = () =>
    getSubscription()
      .then(setView)
      .catch(() => setView(null));

  useEffect(() => {
    void load();
  }, []);

  if (!view) return null;
  const sub = view.subscription;
  const recharge = sub?.line === "evergreen" ? (sub.budgetRechargeMinor ?? 0) : 0;
  const currency = sub?.currencyCode ?? "USD";

  if (view.plan?.choice === "once" && !(sub && !sub.cancelAtPeriodEnd)) {
    return (
      <div className={`text-sm text-zinc-300 ${className}`}>
        <p>
          <span className="font-medium text-zinc-100">Just this once:</span> no monthly recharge. Your ad stops when
          the budget runs out.{" "}
          <Link href="/dashboard/subscription" className="text-amber-300 underline-offset-2 hover:underline">
            Turn on Keep it running
          </Link>
        </p>
      </div>
    );
  }
  if (!sub || recharge <= 0) return null;

  async function onSave() {
    setBusy(true);
    setNote(null);
    try {
      const r = await setMonthlyAdBudget(pick);
      setEditing(false);
      setNote(
        r.testMode
          ? "Test mode: the test charge stays 50 cents."
          : `Saved. From your next monthly payment: ${formatMoney(r.budgetRechargeMinor, currency)} ad budget. Nothing is charged now.`,
      );
      await load();
    } catch (err) {
      setNote(err instanceof ApiError && err.detail ? err.detail : "Could not change it just now. Try again in a minute.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`text-sm ${className}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-zinc-100">
          Monthly ad budget: <span className="font-semibold">{formatMoney(recharge, currency)}</span>
        </p>
        {!editing && !sub.cancelAtPeriodEnd && (
          <Button
            variant="ghost"
            onClick={() => {
              setPick(recharge);
              setEditing(true);
            }}
          >
            Change
          </Button>
        )}
      </div>
      <p className="mt-1 text-zinc-400">
        {sub.cancelAtPeriodEnd
          ? "Your plan won't renew, so nothing more is added."
          : `Added to your ad budget automatically each month with the ${formatMoney(PLAN_PRICE_CENTS_PER_MONTH, "USD")} plan fee. 100% of it goes to Google.`}
      </p>
      {editing && (
        <div className="mt-3">
          <TopUpPicker mode="choose" currency={currency} value={pick} onChange={setPick} />
          <p className="mt-2 text-xs text-zinc-400">
            From {formatMoney(MONTHLY_AD_BUDGET_CENTS, "USD")}. Applies from your next monthly payment; nothing is
            charged now.
          </p>
          <div className="mt-2 flex gap-2">
            <Button disabled={busy} onClick={onSave}>
              {busy ? "Saving…" : `Save ${formatMoney(pick, currency)} a month`}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {note ? <p className="mt-2 text-xs text-amber-300">{note}</p> : null}
    </div>
  );
}

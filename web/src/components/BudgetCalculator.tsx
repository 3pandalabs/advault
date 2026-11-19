"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { TopUpPicker } from "@/components/TopUpPicker";
import { formatMoney } from "@/lib/utils";

// Home-page calculator. Since 2026-11-19 the ad budget is shown ONLY as how
// often the ad is shown (owner): no per-day spend, no monthly figure, no days.
// Same picker and estimate as the wizard (timesShownEstimate in lib/budget).
export function BudgetCalculator() {
  const currency = "USD";
  const [amount, setAmount] = useState<number | null>(null);

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6 backdrop-blur-sm">
      <h3 className="text-lg font-semibold">How often will my ad be shown?</h3>
      <p className="mt-2 text-sm text-zinc-400">
        Pick an ad budget. More budget means your ad is shown more; your ad price stays the same.
      </p>

      <div className="mt-5">
        <TopUpPicker mode="choose" currency={currency} onChange={setAmount} />
      </div>

      {/* Modelled from typical local video CPMs, not a promise about a
          specific neighbourhood. Said plainly. */}
      <p className="mt-5 text-xs leading-relaxed text-zinc-500">
        This is an estimate based on typical costs for local video ads, not a guarantee. Real
        results depend on your area, audience and competition. Unused budget stays in your
        account. No contract.
      </p>

      <div className="mt-5">
        <Link href="/signup">
          <Button size="lg">Start with {amount ? formatMoney(amount, currency) : "$50"}</Button>
        </Link>
      </div>
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import { getSubscription } from "@/lib/api/browser";
import { CostSimulator } from "@/components/CostSimulator";

// "What it costs" for signed-in owners (2026-11-20): the header tab that
// replaced the "What will this cost?" fold on the campaign list. Same
// simulator as the public home page; it says "$0 today" for the plan only
// while the account still has its included first month.
export default function CostsPage() {
  const [firstMonthIncluded, setFirstMonthIncluded] = useState(true);
  useEffect(() => {
    getSubscription()
      .then((s) => setFirstMonthIncluded(s.plan?.firstMonthAvailable !== false))
      .catch(() => undefined);
  }, []);

  return (
    <div>
      <h1 className="mb-6 text-2xl font-semibold tracking-tight">What it costs</h1>
      <CostSimulator
        title="What will this cost?"
        ctaHref="/dashboard/campaigns/new"
        addMoreHref="/dashboard/wallet"
        firstMonthIncluded={firstMonthIncluded}
      />
    </div>
  );
}

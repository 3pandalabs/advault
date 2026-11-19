import Link from "next/link";
import { timesShownEstimate } from "@/lib/budget";
import { ADD_MORE_LINE } from "@/lib/spread";
import { shownPrice } from "@/lib/testMode";

// The price, said the same way everywhere (owner decision 2026-11-19, "$55 a
// month"): the price lines and the trust line. Used on the home page, the
// campaign page (pay / launch), the wizard's pay step and the subscription
// page. Change it here.
//
// Month one: ad $10 + website $10 + plan $0 (first month included, once per
// account, api/src/lib/planBilling) + ad budget $35. Every month after, while
// the ad runs: plan $20 + the $35 ad budget, recharged automatically.

const n = (x: number) => x.toLocaleString("en-US");

export function PlanPriceLines({
  testMode,
  firstMonthIncluded = true,
  website = true,
  addMoreHref,
  className = "",
}: {
  /** Admin testing as a customer: the $10s and $20 are charged at the test price (never the ad budget). */
  testMode?: boolean;
  /** False once the account has used its included month. */
  firstMonthIncluded?: boolean;
  /** Show the website line (hide where a website is not on offer). */
  website?: boolean;
  /** Where "Add to your ad budget anytime" links; no link when absent. */
  addMoreHref?: string;
  className?: string;
}) {
  const est = timesShownEstimate(3_500, "USD");
  return (
    <div className={`text-sm ${className}`}>
      <ul className="space-y-1.5">
        <li className="flex justify-between gap-3">
          <span className="text-zinc-400">Your ad</span>
          <span className="text-right text-zinc-100">{shownPrice("$10", testMode)} once</span>
        </li>
        {website && (
          <li className="flex justify-between gap-3">
            <span className="text-zinc-400">Your website</span>
            <span className="text-right text-zinc-100">
              {shownPrice("$10", testMode)} once, then included while your plan runs
            </span>
          </li>
        )}
        <li className="flex justify-between gap-3">
          <span className="text-zinc-400">AdVault plan</span>
          <span className="text-right text-zinc-100">
            {shownPrice("$20", testMode)} a month while your ad runs
            {firstMonthIncluded ? <span className="text-emerald-300"> — first month included</span> : null}
          </span>
        </li>
        <li className="flex justify-between gap-3">
          <span className="text-zinc-400">Ad budget</span>
          <span className="text-right text-zinc-100">
            $35 a month, 100% to Google, recharged each month{" "}
            <span className="text-zinc-400">
              (shown about {n(est.low)}–{n(est.high)} times)
            </span>
          </span>
        </li>
      </ul>
      <p className="mt-3 text-xs text-zinc-400">
        Every dollar of your ad budget goes to Google. AdVault earns only the $10s and the $20. Pause anytime: no fee
        and no recharge while paused.
      </p>
      <p className="mt-1 text-xs text-zinc-400">
        {addMoreHref ? (
          <Link href={addMoreHref} className="text-amber-300 underline-offset-2 hover:underline">
            {ADD_MORE_LINE}
          </Link>
        ) : (
          ADD_MORE_LINE
        )}
      </p>
    </div>
  );
}

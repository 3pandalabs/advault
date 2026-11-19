import { timesShownEstimate } from "@/lib/budget";
import { shownPrice } from "@/lib/testMode";

// The price, said the same way everywhere (owner decision 2026-11-19): three
// lines and the trust line. Used on the home page, the campaign page (pay /
// launch), the wizard's pay step and the subscription page. Change it here.
//
// "$19 a month while your ad is running. Pause anytime: no fee while paused."
// The first month is included with the first ad, once per account
// (api/src/lib/planBilling).

const n = (x: number) => x.toLocaleString("en-US");

export function PlanPriceLines({
  testMode,
  firstMonthIncluded = true,
  budgetCents = 3_500,
  className = "",
}: {
  /** Admin testing as a customer: the $10 and $19 are charged at the test price. */
  testMode?: boolean;
  /** False once the account has used its included month. */
  firstMonthIncluded?: boolean;
  budgetCents?: number;
  className?: string;
}) {
  const est = timesShownEstimate(budgetCents, "USD");
  return (
    <div className={`text-sm ${className}`}>
      <ul className="space-y-1.5">
        <li className="flex justify-between gap-3">
          <span className="text-zinc-400">Your ad</span>
          <span className="text-right text-zinc-100">{shownPrice("$10", testMode)} once</span>
        </li>
        <li className="flex justify-between gap-3">
          <span className="text-zinc-400">Ad budget</span>
          <span className="text-right text-zinc-100">
            from $35, 100% goes to Google{" "}
            <span className="text-zinc-400">
              (shown about {n(est.low)}–{n(est.high)} times)
            </span>
          </span>
        </li>
        <li className="flex justify-between gap-3">
          <span className="text-zinc-400">AdVault plan</span>
          <span className="text-right text-zinc-100">
            {shownPrice("$19", testMode)} a month while your ad runs
            {firstMonthIncluded ? <span className="text-emerald-300"> — first month included</span> : null}
          </span>
        </li>
      </ul>
      <p className="mt-3 text-xs text-zinc-400">
        Every dollar of your ad budget goes to Google. AdVault earns only the $10 and the $19. Pause anytime: no fee
        while paused.
      </p>
    </div>
  );
}

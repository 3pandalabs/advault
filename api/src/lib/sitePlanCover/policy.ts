// "$55 a month": until when the AdVault plan covers the website's Pro plan on
// SiteVault. Pure, tested.

export type CoverSub = {
  status: string;
  currentPeriodEnd: Date | null;
} | null;

/**
 * The paid period end of a live plan (active, or past_due inside the grace
 * window, which still serves), or null = nothing to cover. A plan that is
 * stopping still covers its paid period. The included first month counts: the
 * site was paid for ($10) and the plan is running.
 */
export function sitePlanCoverUntil(sub: CoverSub, now: Date): Date | null {
  if (!sub || !sub.currentPeriodEnd) return null;
  if (sub.status !== "active" && sub.status !== "past_due") return null;
  if (sub.currentPeriodEnd.getTime() <= now.getTime()) return null;
  return sub.currentPeriodEnd;
}

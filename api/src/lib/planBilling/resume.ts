import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "../../db/index.js";
import { campaigns } from "../../db/schema.js";
import { unfreezeCardsForUser } from "../billing/managedCard.js";
import { resumeFundedCampaigns } from "../billing/resume.js";
import { ensurePlanForRunning, syncPlanBillingForUser } from "./index.js";

/**
 * A top-up landed (API, payment webhook). If the empty budget had paused an
 * ad, make sure the $19 plan covers it (restart off-session with the saved
 * card when its period ran out while paused), switch the ad back on, then let
 * the plan follow (un-stop a stopping one). Never throws.
 */
export async function resumeAfterTopUp(userId: string): Promise<number> {
  try {
    const [waiting] = await db
      .select({ id: campaigns.id })
      .from(campaigns)
      .where(and(eq(campaigns.userId, userId), eq(campaigns.status, "paused"), isNotNull(campaigns.pausedForFundsAt)))
      .limit(1);
    if (!waiting) return 0;
    await ensurePlanForRunning(userId);
    const resumed = await resumeFundedCampaigns(userId);
    if (resumed > 0) await syncPlanBillingForUser(userId);
    return resumed;
  } catch (err) {
    console.log(JSON.stringify({ job: "plan-billing", msg: "resume after top-up threw", extra: { userId, error: String(err) } }));
    return 0;
  }
}

/**
 * "$55 a month": a paid plan month just credited its ad budget to the wallet
 * (subscriptions markInvoicePaid). Same as a top-up landing: undo a card
 * freeze, then restart what the empty budget paused. Never throws.
 */
export async function afterPlanBudgetCredit(userId: string): Promise<number> {
  await unfreezeCardsForUser(userId).catch((err) =>
    console.log(JSON.stringify({ job: "plan-billing", msg: "card unfreeze after budget recharge failed", extra: { userId, error: String(err) } })),
  );
  return resumeAfterTopUp(userId);
}

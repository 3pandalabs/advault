import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "../../db/index.js";
import { adAccounts, campaigns } from "../../db/schema.js";
import { enableCampaign, isMccConfigured, mccAccessToken } from "../googleAds/mcc.js";
import { getBalance, MIN_FUNDED_DAYS } from "../wallet/index.js";
import { campaignsToResume } from "../wallet/runway.js";
import { planAllowsRunningFor } from "../planBilling/index.js";

// A top-up restarts what an empty wallet stopped (2026-11-19).
//
// render/spendSync.ts pauses a platform-funded campaign at Google when the
// balance hits zero and sets `paused_for_funds_at`. Until now nothing ever
// switched it back on: the customer topped up, the card unfroze, and the ad
// stayed paused with no button anywhere to restart it (they have no Google
// access). Called from the top-up webhook (immediately) and from the spend
// sync every hour (backstop for a failed Google call).
//
// Only campaigns WE paused for funds are touched — never one paused for any
// other reason — and only when the balance again covers the launch guard's
// MIN_FUNDED_DAYS, so a tiny top-up cannot flap a campaign on and off.

function log(msg: string, extra?: unknown): void {
  console.log(JSON.stringify({ job: "resume-funded", msg, extra: extra ?? undefined }));
}

/** Restarts this user's paused-for-funds campaigns the balance can cover. Never throws. */
export async function resumeFundedCampaigns(userId: string): Promise<number> {
  try {
    if (!isMccConfigured()) return 0;
    const rows = await db
      .select({
        id: campaigns.id,
        dailyMinor: campaigns.dailyBudgetCents,
        endsOn: campaigns.endsOn,
        resourceName: campaigns.googleCampaignResourceName,
        customerId: adAccounts.customerId,
      })
      .from(campaigns)
      .innerJoin(adAccounts, eq(campaigns.adAccountId, adAccounts.id))
      .where(
        and(
          eq(campaigns.userId, userId),
          eq(campaigns.status, "paused"),
          isNotNull(campaigns.pausedForFundsAt),
          eq(adAccounts.billingMode, "platform"),
          isNotNull(campaigns.googleCampaignResourceName),
          isNotNull(adAccounts.customerId),
        ),
      );
    if (rows.length === 0) return 0;

    // The $19 plan must cover now (lib/planBilling). A plan that stopped and
    // whose period ran out is restarted by the API top-up path (off-session)
    // before this runs; without that the customer resumes from the campaign
    // page, which takes them through the plan checkout.
    if (!(await planAllowsRunningFor(userId))) {
      log("not resuming: no plan covers now", { userId });
      return 0;
    }

    const balance = (await getBalance(userId))?.balanceMinor ?? 0;
    const pick = campaignsToResume({
      balanceMinor: balance,
      candidates: rows,
      fundedDays: MIN_FUNDED_DAYS,
      todayIso: new Date().toISOString().slice(0, 10),
    });
    if (pick.length === 0) return 0;

    const accessToken = await mccAccessToken();
    let resumed = 0;
    for (const c of pick) {
      try {
        await enableCampaign({ accessToken, customerId: c.customerId!, campaignResourceName: c.resourceName! });
        await db
          .update(campaigns)
          .set({ status: "live", pausedForFundsAt: null, lowBalanceAlertedAt: null, updatedAt: new Date() })
          .where(eq(campaigns.id, c.id));
        resumed += 1;
        log("resumed a campaign after a top-up", { campaignId: c.id });
      } catch (err) {
        log("could not resume a campaign", { campaignId: c.id, error: String(err) });
      }
    }
    return resumed;
  } catch (err) {
    log("resume threw", { userId, error: String(err) });
    return 0;
  }
}

/** Every user with a paused-for-funds platform campaign (spend sync backstop). */
export async function resumeAllFundedCampaigns(): Promise<number> {
  const users = await db
    .selectDistinct({ userId: campaigns.userId })
    .from(campaigns)
    .where(and(eq(campaigns.status, "paused"), isNotNull(campaigns.pausedForFundsAt)));
  let n = 0;
  for (const u of users) n += await resumeFundedCampaigns(u.userId);
  return n;
}

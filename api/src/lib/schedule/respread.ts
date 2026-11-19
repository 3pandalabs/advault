// "More budget means more days" ("$55 a month", option C). When ad budget is
// added (a top-up, or a plan month's $35 recharge), re-pick the days of every
// launched 'spread' campaign the wallet pays for, from the balance now on
// hand, and send the change to Google as a schedule edit (the same atomic
// targeting mutate the owner's own edits use). 'custom' schedules are never
// touched. Never throws: a failed edit leaves the old days serving, which the
// wallet's stop rule (render/spendSync.ts) still covers.

import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "../../db/index.js";
import { adAccounts, campaigns } from "../../db/schema.js";
import { categoryKey } from "../categories/key.js";
import { isMccConfigured, mccAccessToken } from "../googleAds/mcc.js";
import { applyTargetingEdit } from "../googleAds/targeting.js";
import { getBalance } from "../wallet/index.js";
import { adScheduleCriteria } from "./policy.js";
import { sameSchedule, spreadSchedule } from "./spread.js";

function log(msg: string, extra?: unknown): void {
  console.log(JSON.stringify({ job: "schedule-spread", msg, extra: extra ?? undefined }));
}

export async function respreadForUser(userId: string): Promise<number> {
  try {
    if (!isMccConfigured()) return 0;
    const rows = await db
      .select({ campaign: campaigns, account: adAccounts })
      .from(campaigns)
      .innerJoin(adAccounts, eq(campaigns.adAccountId, adAccounts.id))
      .where(
        and(
          eq(campaigns.userId, userId),
          eq(campaigns.scheduleMode, "spread"),
          inArray(campaigns.status, ["live", "paused"]),
          isNotNull(campaigns.googleCampaignResourceName),
          isNotNull(campaigns.googleAdGroupResourceName),
          eq(adAccounts.billingMode, "platform"),
          isNotNull(adAccounts.customerId),
        ),
      );
    if (rows.length === 0) return 0;
    const balance = (await getBalance(userId))?.balanceMinor ?? 0;
    let changed = 0;
    let accessToken: string | null = null;
    for (const { campaign, account } of rows) {
      const next = spreadSchedule({
        monthlyBudgetMinor: balance,
        dailyMinor: campaign.dailyBudgetCents,
        categoryKey: categoryKey(campaign.businessCategory),
      });
      if (sameSchedule(next, campaign.adSchedule)) continue;
      try {
        accessToken ??= await mccAccessToken();
        const customerId = campaign.googleCustomerId ?? account.customerId!;
        await applyTargetingEdit(
          { accessToken, customerId, loginCustomerId: account.loginCustomerId },
          {
            customerId,
            campaignResourceName: campaign.googleCampaignResourceName!,
            adGroupResourceName: campaign.googleAdGroupResourceName!,
          },
          { adSchedule: adScheduleCriteria(next) },
        );
        await db.update(campaigns).set({ adSchedule: next, updatedAt: new Date() }).where(eq(campaigns.id, campaign.id));
        changed += 1;
        log("re-spread after budget was added", { campaignId: campaign.id, days: next?.days ?? "every day" });
      } catch (err) {
        log("re-spread failed", { campaignId: campaign.id, error: String(err).slice(0, 300) });
      }
    }
    return changed;
  } catch (err) {
    log("re-spread threw", { userId, error: String(err) });
    return 0;
  }
}

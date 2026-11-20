// Take down an ad (admin, /dashboard/admin/reports; routes/reports.ts).
//
// Uses only EXISTING levers, never a new spend path:
//   1. the row: compliance_status = taken_down (+ who/when/why); the
//      paused-for-funds marker is cleared so no top-up / plan month resume
//      path (lib/billing/resume.ts, lib/planBilling) ever picks it up again;
//   2. Google: the same PAUSED status flip the customer's own /pause uses
//      (managed MCC accounts); a launched campaign we cannot reach stays as it
//      is and ops get an URGENT alert to pause it by hand;
//   3. YouTube: each published video set to private (setVideoPrivate), with
//      the token of the channel it is on. Needs the `youtube` scope; until the
//      org token is re-minted with it this fails and ops are told to do it.
// After this, launch / resume / generate / redo / new-ad order / script edit /
// retry / upload all answer 409 ad_taken_down, and the YouTube worker refuses
// to publish its videos. SiteVault: a launch video already pushed to the
// customer's website is NOT removed here (follow-up, api/ROUTES.md).

import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "../../db/index.js";
import { adAccounts, adReports, campaigns, creatives } from "../../db/schema.js";
import { syncCardLimit } from "../billing/managedCard.js";
import { isMccConfigured, mccAccessToken, pauseCampaign } from "../googleAds/mcc.js";
import { notifyOps } from "../ops/notify.js";
import { syncPlanBillingForUser } from "../planBilling/index.js";
import { decryptToken } from "../crypto.js";
import { refreshAccessToken } from "../googleAds/oauth.js";
import { isOrgChannelConfigured, orgRefreshTokenCiphertext } from "../youtube/env.js";
import { uploadCredentialFor } from "../youtube/channels.js";
import { setVideoPrivate } from "../youtube/upload.js";

export type TakedownResult = {
  google: "paused" | "not_launched" | "already_paused" | "failed" | "unreachable";
  videos: { videoId: string; private: boolean; reason?: string }[];
};

async function youtubeToken(source: string | null, userId: string): Promise<string | null> {
  try {
    if (source === "advertiser") {
      const c = await uploadCredentialFor(userId);
      return c.source === "advertiser" ? c.accessToken : null;
    }
    if (!isOrgChannelConfigured()) return null;
    return await refreshAccessToken(decryptToken(orgRefreshTokenCiphertext()!));
  } catch {
    return null;
  }
}

export async function takeDownCampaign(args: {
  campaignId: string;
  adminId: string;
  reason: string;
}): Promise<TakedownResult | null> {
  const now = new Date();
  const [before] = await db.select().from(campaigns).where(eq(campaigns.id, args.campaignId)).limit(1);
  if (!before) return null;

  await db
    .update(campaigns)
    .set({
      complianceStatus: "taken_down",
      takenDownAt: now,
      takenDownBy: args.adminId,
      takenDownReason: args.reason.slice(0, 1000),
      pausedForFundsAt: null,
      lowBalanceAlertedAt: null,
      updatedAt: now,
    })
    .where(eq(campaigns.id, args.campaignId));

  // 2. Google: pause, the existing status flip.
  let google: TakedownResult["google"] = "not_launched";
  let billingMode: string | null = null;
  if (before.googleCampaignResourceName) {
    const [account] = before.adAccountId
      ? await db.select().from(adAccounts).where(eq(adAccounts.id, before.adAccountId)).limit(1)
      : [];
    billingMode = account?.billingMode ?? null;
    const customerId = before.googleCustomerId ?? account?.customerId ?? null;
    if (before.status !== "live") {
      google = "already_paused";
    } else if (!account || !account.isManaged || !customerId || !isMccConfigured()) {
      google = "unreachable";
    } else {
      try {
        await pauseCampaign({
          accessToken: await mccAccessToken(),
          customerId,
          campaignResourceName: before.googleCampaignResourceName,
        });
        await db.update(campaigns).set({ status: "paused", updatedAt: new Date() }).where(eq(campaigns.id, args.campaignId));
        google = "paused";
      } catch {
        google = "failed";
      }
    }
  }

  // 3. YouTube: every published video of this campaign to private.
  const published = await db
    .select({ videoId: creatives.youtubeVideoId, source: creatives.youtubeChannelSource })
    .from(creatives)
    .where(and(eq(creatives.campaignId, args.campaignId), isNotNull(creatives.youtubeVideoId)));
  const videos: TakedownResult["videos"] = [];
  for (const v of published) {
    const token = await youtubeToken(v.source, before.userId);
    if (!token) {
      videos.push({ videoId: v.videoId!, private: false, reason: "no_channel_token" });
      continue;
    }
    const r = await setVideoPrivate(token, v.videoId!).catch((err) => ({ ok: false as const, status: 0, reason: String(err) }));
    videos.push(r.ok ? { videoId: v.videoId!, private: true } : { videoId: v.videoId!, private: false, reason: r.reason });
  }

  // Open reports for it are handled by this.
  await db
    .update(adReports)
    .set({ status: "actioned", handledBy: args.adminId, handledAt: now })
    .where(and(eq(adReports.campaignId, args.campaignId), eq(adReports.status, "open")));

  // The plan follows the running ad; the card limit follows the live budget.
  if (google === "paused") {
    if (billingMode === "platform") await syncCardLimit(before.userId).catch(() => undefined);
    await syncPlanBillingForUser(before.userId).catch(() => undefined);
  }

  const manual: string[] = [];
  if (google === "failed" || google === "unreachable") manual.push(`PAUSE BY HAND in Google Ads: ${before.googleCustomerId ?? "?"} ${before.googleCampaignResourceName}`);
  const notPrivate = videos.filter((v) => !v.private);
  if (notPrivate.length) manual.push(`Set private by hand on YouTube: ${notPrivate.map((v) => `${v.videoId} (${v.reason})`).join(", ")}`);
  await notifyOps({
    title: `AdVault: ad taken down (${before.businessName})`,
    message: [
      `"${before.name}" by ${before.businessName} was taken down. Reason: ${args.reason}`,
      `Google: ${google}. Videos made private: ${videos.filter((v) => v.private).length}/${videos.length}.`,
      ...manual,
      "If it was on an AdVault-made website (SiteVault launch video), remove that by hand too.",
    ].join("\n"),
    priority: manual.length ? 5 : 3,
    tags: ["no_entry"],
  });

  return { google, videos };
}

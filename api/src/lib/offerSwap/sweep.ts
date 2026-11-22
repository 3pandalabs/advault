// The swap sweep (2026-11-21): moves every open offer change one step along
// the state machine in ./policy.ts (nextSwapStep). Runs in the renderer
// (render/offerSwaps.ts, every OFFER_SWAP_SWEEP_INTERVAL_MS, default 10 min),
// which already holds the Google credentials and runs the YouTube queue.
//
// Google is reached through a small port so the whole state machine is
// tested on PGlite with Google stubbed (sweep.test.ts). The real port calls
// lib/googleAds/adSwap.ts.
//
// The rules that matter:
//   - The NEW ad is added (ENABLED; Google serves it only once approved)
//     while the old ad keeps serving: no gap.
//   - The old ad is paused/removed ONLY after Google approves the new one,
//     in one mutate, so both offers are live at most one sweep interval.
//   - Disapproved: the NEW ad is removed, the old one keeps running, ops are
//     paged and the owner told.
//   - End date: back to the base ad (enable base + remove the offer ad in one
//     mutate). The campaign keeps running; nothing pauses it. An expired
//     offer is never left serving, even with no base to return to (then ops
//     are paged: the campaign shows nothing until a base exists).

import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db/index.js";
import { adAccounts, campaigns, creatives, offerChanges } from "../../db/schema.js";
import { decryptToken } from "../crypto.js";
import { isMccConfigured, mccAccessToken } from "../googleAds/mcc.js";
import { refreshAccessToken } from "../googleAds/oauth.js";
import { buildAdCopy, findYoutubeVideoAsset, type GoogleCtx } from "../googleAds/demandGen.js";
import { addAd, adGroupOf, changeAdStatuses, readAd, type AddAdPlan, type AdDetails, type StatusChanges } from "../googleAds/adSwap.js";
import { notifyOps } from "../ops/notify.js";
import { TEMPLATES } from "../whatsapp/index.js";
import { launchedAdOf, launchedCreatives, renderFacts, startPublishing } from "./index.js";
import {
  nextSwapStep,
  swapBackToBaseMessage,
  swapDisapprovedMessage,
  swapLiveMessage,
  swapProblemMessage,
  type SwapStep,
} from "./policy.js";
import { notifyOwner, sendSwapPreview } from "./whatsapp.js";

type Change = typeof offerChanges.$inferSelect;
type Campaign = typeof campaigns.$inferSelect;

export type GooglePort = {
  ctxFor(campaign: Campaign): Promise<GoogleCtx | null>;
  readAd(ctx: GoogleCtx, resourceName: string): Promise<AdDetails | null>;
  addAd(ctx: GoogleCtx, plan: AddAdPlan): Promise<string | null>;
  changeAdStatuses(ctx: GoogleCtx, ch: StatusChanges): Promise<void>;
  findVideoAsset(ctx: GoogleCtx, youtubeVideoId: string): Promise<string | null>;
};

/** Same credential choice as launch and adMetricsSync. */
async function realCtxFor(campaign: Campaign): Promise<GoogleCtx | null> {
  if (!campaign.adAccountId) return null;
  const [account] = await db.select().from(adAccounts).where(eq(adAccounts.id, campaign.adAccountId)).limit(1);
  if (!account || account.status !== "active") return null;
  const customerId = campaign.googleCustomerId ?? account.customerId;
  if (!customerId) return null;
  let accessToken: string;
  if (account.isManaged) {
    if (!isMccConfigured()) return null;
    accessToken = await mccAccessToken();
  } else {
    if (!account.refreshTokenCiphertext) return null;
    accessToken = await refreshAccessToken(decryptToken(account.refreshTokenCiphertext));
  }
  return { accessToken, customerId, loginCustomerId: account.loginCustomerId };
}

export const realGooglePort: GooglePort = {
  ctxFor: realCtxFor,
  readAd,
  addAd,
  changeAdStatuses,
  findVideoAsset: findYoutubeVideoAsset,
};

function log(msg: string, extra?: unknown) {
  console.log(JSON.stringify({ job: "offer-swap", msg, extra: extra ?? undefined }));
}

async function setChange(id: string, patch: Partial<typeof offerChanges.$inferInsert>) {
  await db.update(offerChanges).set({ ...patch, updatedAt: new Date() }).where(eq(offerChanges.id, id));
}

const alert = (title: string, message: string, priority: 3 | 4 | 5 = 4) =>
  notifyOps({ title, message, priority, tags: ["advault", "offer-change"] });

/** The ad the campaign is serving right now, fresh. */
async function currentServing(campaign: Campaign): Promise<string | null> {
  if (campaign.liveOfferChangeId) {
    const [live] = await db.select({ ad: offerChanges.googleAdResourceName }).from(offerChanges).where(eq(offerChanges.id, campaign.liveOfferChangeId)).limit(1);
    if (live?.ad) return live.ad;
  }
  return campaign.baseAdResourceName ?? launchedAdOf(await launchedCreatives(campaign.id));
}

/** Builds the add-an-ad plan from the serving ad (final URL, logo) and the change's cuts. */
async function planFor(port: GooglePort, ctx: GoogleCtx, campaign: Campaign, change: Change, status: "ENABLED" | "PAUSED"): Promise<AddAdPlan> {
  const serving = await currentServing(campaign);
  const details = serving ? await port.readAd(ctx, serving) : null;
  if (!details?.finalUrl || !details.logoAsset) throw new Error("could not read the serving ad's final URL and logo from Google");
  const adGroup = campaign.googleAdGroupResourceName ?? adGroupOf(details.resourceName);
  if (!adGroup) throw new Error("campaign has no ad group");
  const cuts = await db.select().from(creatives).where(eq(creatives.offerChangeId, change.id));
  const videos = await Promise.all(
    cuts.map(async (c) => {
      const existing = await port.findVideoAsset(ctx, c.youtubeVideoId!);
      return existing ? { existing } : { youtubeVideoId: c.youtubeVideoId!, title: `${campaign.businessName} — ${campaign.name}` };
    }),
  );
  return {
    customerId: ctx.customerId,
    adGroup,
    name: `${campaign.name} (${change.kind === "base" ? "base" : "offer"} ${change.id.slice(0, 8)})`,
    // Live ads keep the URL they launched with (utm tags included).
    finalUrl: details.finalUrl,
    copy: buildAdCopy({
      businessName: campaign.businessName,
      businessCategory: campaign.businessCategory,
      callToAction: change.callToAction ?? campaign.callToAction,
      offerDetails: change.kind === "offer" ? change.offerText : null,
      script: (cuts[0]?.script ?? null) as { hook?: string } | null,
    }),
    videos,
    logoAsset: details.logoAsset,
    status,
  };
}

export type SweepStats = Partial<Record<SwapStep | "error", number>>;

export async function runOfferSwapSweep(opts: { now?: Date; google?: GooglePort } = {}): Promise<SweepStats> {
  const now = opts.now ?? new Date();
  const port = opts.google ?? realGooglePort;
  const stats: SweepStats = {};
  const open = await db
    .select()
    .from(offerChanges)
    .where(inArray(offerChanges.status, ["rendering", "publishing", "pending_google", "live"]))
    .limit(200);

  for (const change of open) {
    try {
      const step = await advance(change, port, now);
      if (step !== "wait") stats[step] = (stats[step] ?? 0) + 1;
    } catch (err) {
      // One campaign's failure must not stop the sweep for everyone else.
      stats.error = (stats.error ?? 0) + 1;
      log("offer change step failed", { changeId: change.id, error: String(err) });
      await setChange(change.id, { error: String(err).slice(0, 1000) });
      if (!change.opsAlertedAt) {
        await alert("AdVault: offer change stuck", `Offer change ${change.id} (campaign ${change.campaignId}, ${change.status}) failed: ${String(err).slice(0, 300)}. The current ad keeps running; the sweep retries.`);
        await setChange(change.id, { opsAlertedAt: now });
      }
    }
  }
  return stats;
}

async function advance(change: Change, port: GooglePort, now: Date): Promise<SwapStep> {
  const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, change.campaignId)).limit(1);
  if (!campaign) return "wait";
  // A taken-down ad (lib/compliance) is never published or swapped.
  if (campaign.complianceStatus === "taken_down" && change.status !== "live") return "wait";

  const facts = await renderFacts(change.id);
  let ctx: GoogleCtx | null = null;
  let newAd: AdDetails | null = null;
  const needsGoogle =
    (change.status === "publishing" && facts.uploaded) ||
    change.status === "pending_google" ||
    // A live offer needs Google only on its end date (no token minted every sweep).
    (change.status === "live" && change.kind === "offer" && !!change.endsAt && change.endsAt.getTime() <= now.getTime());
  if (needsGoogle) {
    ctx = await port.ctxFor(campaign);
    if (!ctx) return "wait"; // no credential reachable (unconfigured env): try next sweep
    if (change.status === "pending_google" && change.googleAdResourceName) newAd = await port.readAd(ctx, change.googleAdResourceName);
  }

  const step = nextSwapStep({
    kind: change.kind,
    status: change.status,
    rendersReady: facts.rendersReady,
    renderFailed: facts.renderFailed,
    uploaded: facts.uploaded,
    uploadFailed: facts.uploadFailed,
    googlePolicy: newAd?.policy ?? null,
    googleAddedAt: change.googleAddedAt,
    opsAlertedAt: change.opsAlertedAt,
    endsAt: change.endsAt,
    now,
  });

  switch (step) {
    case "wait":
      return step;

    case "preview_ready":
      await setChange(change.id, { status: "preview", error: null });
      await sendSwapPreview({ ...change, status: "preview" }, now);
      return step;

    case "render_failed":
    case "upload_failed":
      await setChange(change.id, { status: "failed", error: step === "render_failed" ? "the new cut did not render" : "the new cut could not be published to YouTube" });
      await alert("AdVault: offer change failed", `${change.kind === "base" ? "Base cut" : "Offer change"} ${change.id} for "${campaign.businessName}" failed (${step}). The current ad keeps running.`);
      if (change.kind === "offer") {
        await notifyOwner({ userId: change.userId, changeId: change.id, text: swapProblemMessage(), template: TEMPLATES.offerChangeProblem, params: [campaign.businessName], now });
      }
      return step;

    case "park_base": {
      if (change.status === "rendering") {
        // The base is published at once (no preview): it is our cut, not the owner's offer.
        await startPublishing(change.id, {}, now);
        return step;
      }
      const rn = await port.addAd(ctx!, await planFor(port, ctx!, campaign, change, "PAUSED"));
      await db.update(creatives).set({ googleAdResourceName: rn }).where(eq(creatives.offerChangeId, change.id));
      await setChange(change.id, { status: "parked", googleAdResourceName: rn, googleAddedAt: now, error: null });
      await db.update(campaigns).set({ baseAdResourceName: rn, updatedAt: now }).where(eq(campaigns.id, campaign.id));
      return step;
    }

    case "add_to_google": {
      const serving = await currentServing(campaign);
      const rn = await port.addAd(ctx!, await planFor(port, ctx!, campaign, change, "ENABLED"));
      // The new cuts now point at their ad: never re-published or edited.
      await db.update(creatives).set({ googleAdResourceName: rn }).where(eq(creatives.offerChangeId, change.id));
      await setChange(change.id, { status: "pending_google", googleAdResourceName: rn, replacedAdResourceName: serving, googleAddedAt: now, error: null });
      return step;
    }

    case "alert_slow_review":
      await alert("AdVault: Google still reviewing an offer change", `Offer change ${change.id} for "${campaign.businessName}" has waited over 48 h for Google's review. The old ad keeps running.`, 3);
      await setChange(change.id, { opsAlertedAt: now });
      return step;

    case "disapproved":
      await port.changeAdStatuses(ctx!, { remove: [change.googleAdResourceName!] });
      await setChange(change.id, { status: "disapproved", error: `Google disapproved the new ad${newAd?.topics.length ? `: ${newAd.topics.join(", ")}` : ""}` });
      await alert("AdVault: Google disapproved an offer change", `"${campaign.businessName}" offer "${change.offerText ?? ""}" was disapproved (${newAd?.topics.join(", ") || "no topic"}). New ad removed; the old ad keeps running.`);
      await notifyOwner({ userId: change.userId, changeId: change.id, text: swapDisapprovedMessage(), template: TEMPLATES.offerChangeProblem, params: [campaign.businessName], now });
      return step;

    case "promote": {
      if (change.endsAt && change.endsAt.getTime() <= now.getTime()) {
        // Approved only after its own end date: it never goes live.
        await port.changeAdStatuses(ctx!, { remove: [change.googleAdResourceName!] });
        await setChange(change.id, { status: "ended", endedAt: now });
        return "restore_base";
      }
      const serving = await currentServing(campaign);
      const launchAd = launchedAdOf(await launchedCreatives(campaign.id));
      const keep = serving && (serving === campaign.baseAdResourceName || serving === launchAd);
      const ch: StatusChanges =
        serving && serving !== change.googleAdResourceName ? (keep ? { pause: [serving] } : { remove: [serving] }) : {};
      await port.changeAdStatuses(ctx!, ch);
      if (serving && serving === campaign.baseAdResourceName) {
        await db
          .update(offerChanges)
          .set({ status: "parked", updatedAt: now })
          .where(and(eq(offerChanges.campaignId, campaign.id), eq(offerChanges.kind, "base"), eq(offerChanges.googleAdResourceName, serving)));
      }
      if (campaign.liveOfferChangeId && campaign.liveOfferChangeId !== change.id) {
        await setChange(campaign.liveOfferChangeId, { status: "ended", endedAt: now });
      }
      await setChange(change.id, { status: "live", liveAt: now, replacedAdResourceName: serving, error: null });
      await db.update(campaigns).set({ liveOfferChangeId: change.id, updatedAt: now }).where(eq(campaigns.id, campaign.id));
      if (change.endsAt) {
        await notifyOwner({ userId: change.userId, changeId: change.id, text: swapLiveMessage(change.endsAt), template: TEMPLATES.offerChangeLive, params: [campaign.businessName, change.endsAt.toISOString().slice(0, 10)], now });
      }
      return step;
    }

    case "restore_base": {
      const launched = await launchedCreatives(campaign.id);
      const base = campaign.baseAdResourceName;
      const offerAd = change.googleAdResourceName!;
      if (base) {
        const details = await port.readAd(ctx!, base);
        // One mutate: the base comes back and the expired offer goes.
        await port.changeAdStatuses(ctx!, { enable: [base], remove: [offerAd] });
        if (details?.policy === "disapproved") {
          await alert("AdVault: base ad is disapproved", `"${campaign.businessName}" returned to its base ad after an offer ended, but Google marks the base ad disapproved. The campaign may show nothing.`, 5);
        }
        const [baseRow] = await db.select({ id: offerChanges.id }).from(offerChanges).where(and(eq(offerChanges.campaignId, campaign.id), eq(offerChanges.kind, "base"), eq(offerChanges.googleAdResourceName, base))).limit(1);
        if (baseRow) await setChange(baseRow.id, { status: "live", liveAt: now });
      } else {
        // No base yet (its cut failed, or is still being made). An expired
        // offer must not keep serving: pause it and page ops.
        await port.changeAdStatuses(ctx!, { pause: [offerAd] });
        await alert("AdVault: offer ended with no base ad", `"${campaign.businessName}": offer ad paused at its end date, but no base ad exists yet${launchedAdOf(launched) ? " (the launch ad has an offer in it)" : ""}. The campaign shows nothing until one is made.`, 5);
      }
      await setChange(change.id, { status: "ended", endedAt: now });
      await db.update(campaigns).set({ liveOfferChangeId: null, updatedAt: now }).where(eq(campaigns.id, campaign.id));
      await notifyOwner({ userId: change.userId, changeId: change.id, text: swapBackToBaseMessage(), template: TEMPLATES.offerChangeEnded, params: [campaign.businessName], now });
      return step;
    }
  }
}

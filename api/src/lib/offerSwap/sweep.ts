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

import { answerableCallToAction } from "../script/cta.js";
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

/**
 * A status move that only happens from the status it was decided on, so two
 * actors (the periodic sweep and an immediate advance, or two renderer
 * replicas) never both act on one step. false = someone else moved it first.
 */
async function moveChange(id: string, from: Change["status"], patch: Partial<typeof offerChanges.$inferInsert>): Promise<boolean> {
  const moved = await db
    .update(offerChanges)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(offerChanges.id, id), eq(offerChanges.status, from)))
    .returning({ id: offerChanges.id });
  return moved.length > 0;
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
      callToAction: answerableCallToAction(change.callToAction ?? campaign.callToAction),
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
    .select({ id: offerChanges.id })
    .from(offerChanges)
    .where(inArray(offerChanges.status, OPEN_STATUSES))
    .limit(200);

  for (const { id } of open) {
    const step = await stepChange(id, port, now);
    if (step && step !== "wait") stats[step] = (stats[step] ?? 0) + 1;
  }
  return stats;
}

const OPEN_STATUSES: Change["status"][] = ["rendering", "publishing", "pending_google", "live"];

// One step per change at a time in this process. The periodic sweep and the
// immediate advance below both run in the renderer; serialising per change
// and re-reading the row INSIDE the lock means the second one sees the step
// the first one took (e.g. pending_google) instead of adding a second ad at
// Google. moveChange's conditional writes are the cross-process backstop.
const inFlight = new Map<string, Promise<unknown>>();

async function serialized<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const run = (inFlight.get(id) ?? Promise.resolve()).catch(() => undefined).then(fn);
  const tail = run.catch(() => undefined);
  inFlight.set(id, tail);
  try {
    return await run;
  } finally {
    if (inFlight.get(id) === tail) inFlight.delete(id);
  }
}

/** One step for one change, read fresh; errors are recorded, never thrown. */
async function stepChange(id: string, port: GooglePort, now: Date, onlyIn: Change["status"][] = OPEN_STATUSES): Promise<SwapStep | "error" | null> {
  return serialized(id, async () => {
    const [change] = await db.select().from(offerChanges).where(eq(offerChanges.id, id)).limit(1);
    if (!change || !onlyIn.includes(change.status)) return null;
    try {
      return await advance(change, port, now);
    } catch (err) {
      // One campaign's failure must not stop the sweep for everyone else.
      log("offer change step failed", { changeId: change.id, error: String(err) });
      await setChange(change.id, { error: String(err).slice(0, 1000) });
      if (!change.opsAlertedAt) {
        await alert("AdVault: offer change stuck", `Offer change ${change.id} (campaign ${change.campaignId}, ${change.status}) failed: ${String(err).slice(0, 300)}. The current ad keeps running; the sweep retries.`);
        await setChange(change.id, { opsAlertedAt: now });
      }
      return "error";
    }
  });
}

/**
 * The immediate advance (2026-11-22). The renderer calls it right after a cut
 * of an offer change finishes rendering (render/worker.ts) or uploading to
 * YouTube (render/youtubeUploads.ts), so the owner's preview is ready, and
 * the new ad goes to Google, as soon as the last cut is done instead of at
 * the next 10-minute sweep. It runs the SAME step the sweep runs (rendering
 * -> preview incl. sendSwapPreview, rendering -> publishing for a base cut,
 * publishing -> add_to_google / parked), only for a change still in
 * rendering or publishing; the sweep stays the backstop. Never throws.
 */
export async function advanceOfferChangeForCreative(
  creativeId: string,
  opts: { now?: Date; google?: GooglePort } = {},
): Promise<SwapStep | "error" | null> {
  try {
    const [row] = await db.select({ changeId: creatives.offerChangeId }).from(creatives).where(eq(creatives.id, creativeId)).limit(1);
    if (!row?.changeId) return null;
    return await stepChange(row.changeId, opts.google ?? realGooglePort, opts.now ?? new Date(), ["rendering", "publishing"]);
  } catch (err) {
    log("immediate advance failed", { creativeId, error: String(err) });
    return "error";
  }
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
      if (!(await moveChange(change.id, change.status, { status: "preview", error: null }))) return "wait";
      await sendSwapPreview({ ...change, status: "preview" }, now);
      return step;

    case "render_failed":
    case "upload_failed":
      if (!(await moveChange(change.id, change.status, { status: "failed", error: step === "render_failed" ? "the new cut did not render" : "the new cut could not be published to YouTube" }))) return "wait";
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
      if (!(await moveChange(change.id, change.status, { status: "parked", googleAdResourceName: rn, googleAddedAt: now, error: null }))) {
        await alert("AdVault: base cut raced", `Base cut ${change.id} for "${campaign.businessName}": a second paused ad (${rn}) may have been added by a concurrent sweep. Remove the extra one.`);
        return "wait";
      }
      await db.update(creatives).set({ googleAdResourceName: rn }).where(eq(creatives.offerChangeId, change.id));
      await db.update(campaigns).set({ baseAdResourceName: rn, updatedAt: now }).where(eq(campaigns.id, campaign.id));
      return step;
    }

    case "add_to_google": {
      const serving = await currentServing(campaign);
      const rn = await port.addAd(ctx!, await planFor(port, ctx!, campaign, change, "ENABLED"));
      if (!(await moveChange(change.id, change.status, { status: "pending_google", googleAdResourceName: rn, replacedAdResourceName: serving, googleAddedAt: now, error: null }))) {
        // Only possible across processes: the per-change lock covers one renderer.
        await alert("AdVault: offer change raced", `Offer change ${change.id} for "${campaign.businessName}": a second ad (${rn}) may have been added at Google by a concurrent sweep. Remove the extra one.`);
        return "wait";
      }
      // The new cuts now point at their ad: never re-published or edited.
      await db.update(creatives).set({ googleAdResourceName: rn }).where(eq(creatives.offerChangeId, change.id));
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

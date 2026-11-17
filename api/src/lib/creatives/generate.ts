import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { assets, campaigns, creatives } from "../../db/schema.js";
import { generateScript } from "../ai/script/index.js";
import { enqueueRender } from "../../render/jobs.js";
import type { AdScript } from "../script/schema.js";
import { presignDownload } from "../../plugins/r2.js";
import { beforeAfterAllowed, pairAssetIds, withoutPairPhotos, type BeforeAfterKeys } from "../beforeAfter/policy.js";

// Writing the scripts and queueing the renders for a campaign. Shared by the
// wizard's generate route and the paid new-ad order (Keep it running), so both
// get the same ownership check and the same daily spend ceiling.

// Creatives one advertiser may generate per rolling 24 hours.
//
// This is a SPEND control, not an abuse control. Once a motion provider is
// configured every creative costs the org roughly a dollar in vendor fees, and
// that cost lands BEFORE any ad spend — so it sits outside the prepaid wallet
// that guards Google entirely. Without a ceiling here, a user clicking
// "regenerate" in a loop spends the org's money at no cost to themselves.
//
// Deliberately generous: a real advertiser iterating on two aspect ratios uses
// a handful, so this only catches the pathological case.
const MAX_CREATIVES_PER_DAY = Number(process.env.MAX_CREATIVES_PER_DAY ?? 20);

export type AspectRatio = "16:9" | "9:16";

export type GenerateResult =
  | { ok: true; creatives: (typeof creatives.$inferSelect)[] }
  | { ok: false; status: number; body: Record<string, unknown> };

export async function generateForCampaign(args: {
  campaign: typeof campaigns.$inferSelect;
  userId: string;
  assetIds: string[];
  aspectRatios: AspectRatio[];
  /** Chosen photos the advertiser marked as showing people. */
  peopleAssetIds?: string[];
  /** Real estate: the agent's own photo (also counted as people). */
  portraitAssetId?: string | null;
  /** Version number for the new creatives (redo = previous + 1). Default 1. */
  version?: number;
  warn: (msg: string, err: unknown) => void;
}): Promise<GenerateResult> {
  const { campaign, userId } = args;

  // Before & after pairs (lib/beforeAfter): their photos play only in the
  // before/after scene, plain, so they are kept out of the ordinary photos
  // (which get the AI photo pass and motion). Unless that would leave none.
  const pairs = beforeAfterAllowed(campaign.businessCategory) ? (campaign.beforeAfter ?? []) : [];
  const withoutPairs = withoutPairPhotos(args.assetIds, pairs);
  const assetIds = withoutPairs.length > 0 ? withoutPairs : args.assetIds;

  // Next version of this campaign's ad: one more than the newest made one
  // (uploads don't count). Every path that makes a new ad (first generate,
  // paid new ad, redo) goes through here, so they all number the same way.
  const [prev] = await db
    .select({ v: sql<number | null>`max(${creatives.version})` })
    .from(creatives)
    .where(and(eq(creatives.campaignId, campaign.id), sql`${creatives.kind} <> 'upload'`));
  const version = args.version ?? (prev?.v ?? 0) + 1;

  // Filtered by userId as well as by id: without it, an advertiser could
  // pass another advertiser's asset ids and have their photos rendered
  // into an ad. The ownership check is the whole point of this query.
  const ownedAssets = await db
    .select()
    .from(assets)
    .where(and(eq(assets.userId, userId), inArray(assets.id, assetIds)));
  if (ownedAssets.length !== assetIds.length) {
    return { ok: false, status: 400, body: { error: "unknown_assets" } };
  }

  // The pairs as R2 keys, owner-checked again (a deleted photo drops its pair).
  const pairIds = pairAssetIds(pairs);
  const pairRows = pairIds.length
    ? await db
        .select({ id: assets.id, r2Key: assets.r2Key })
        .from(assets)
        .where(and(eq(assets.userId, userId), inArray(assets.id, pairIds)))
    : [];
  const pairKey = new Map(pairRows.map((r) => [r.id, r.r2Key]));
  const beforeAfter: BeforeAfterKeys[] = pairs.flatMap((p) => {
    const beforeKey = pairKey.get(p.beforeAssetId);
    const afterKey = pairKey.get(p.afterAssetId);
    return beforeKey && afterKey ? [{ beforeKey, afterKey }] : [];
  });

  // Counted across all of this user's campaigns, not just this one —
  // per-campaign would be trivially sidestepped by creating campaigns in a
  // loop, which costs nothing. Checked against the number about to be
  // created so a request cannot straddle the ceiling.
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [{ count: recentCount }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(creatives)
    .innerJoin(campaigns, eq(creatives.campaignId, campaigns.id))
    .where(and(eq(campaigns.userId, userId), gte(creatives.createdAt, since)));
  if (recentCount + args.aspectRatios.length > MAX_CREATIVES_PER_DAY) {
    return {
      ok: false,
      status: 429,
      body: { error: "daily_creative_limit", limit: MAX_CREATIVES_PER_DAY, used: recentCount },
    };
  }

  // Preserve the order the advertiser chose — it is the order the scenes
  // will play in, and the model's assetIndex values point into it.
  const orderedKeys = assetIds.map((id) => ownedAssets.find((a) => a.id === id)!.r2Key);

  // Positions in the chosen order, which is what script assetIndex means.
  const indexOf = (id: string) => assetIds.indexOf(id);
  const portraitIndex = args.portraitAssetId ? indexOf(args.portraitAssetId) : -1;
  const peopleIndexes = [...new Set([...(args.peopleAssetIds ?? []).map(indexOf), portraitIndex])]
    .filter((i) => i >= 0)
    .sort((a, b) => a - b);
  const marks = {
    ...(peopleIndexes.length ? { peopleIndexes } : {}),
    ...(portraitIndex >= 0 ? { portraitIndex } : {}),
    ...(beforeAfter.length ? { beforeAfter } : {}),
  };

  // Photos the writer can look at (presigned, short-lived). A presign
  // failure only means a blind script, never a failed generation.
  const imageUrls = await Promise.all(
    orderedKeys.map((k) => (/\.(jpe?g|png|webp|gif)$/i.test(k) ? presignDownload(k) : Promise.resolve(null))),
  ).catch(() => []);
  const visibleUrls = imageUrls.length === orderedKeys.length && imageUrls.every(Boolean) ? (imageUrls as string[]) : undefined;

  const created = [];
  // The first format's narration and sticker, shared by the others: it is
  // the same spot, so one voiceover serves every format and the renderer
  // pays for it once (render/worker.ts caches it by text). Captions stay
  // per format.
  // Voice and per-photo motion are shared too: same narrator, and the same
  // motion line per photo so both formats reuse one clip.
  // The opener prompt too: one opening shot per ad (filmed per format).
  let shared: Pick<AdScript, "voiceoverText" | "sticker" | "voice" | "photoMotions" | "openerPrompt"> | null = null;
  for (const aspectRatio of args.aspectRatios) {
    // Scripted per aspect ratio, not once and reused: a 9:16 Shorts
    // caption sits over a vertical crop with far less horizontal room than
    // the same words in a 16:9 pre-roll.
    const { script, source } = await generateScript(
      {
        businessName: campaign.businessName,
        businessCategory: campaign.businessCategory,
        callToAction: campaign.callToAction,
        offerDetails: campaign.offerDetails,
        targetZipCodes: campaign.targetZipCodes,
        radiusMiles: campaign.radiusMiles,
        aspectRatio,
        assetCount: orderedKeys.length,
        targetAddress: campaign.targetAddress,
        realty: campaign.realty,
        peopleIndexes,
        portraitIndex: portraitIndex >= 0 ? portraitIndex : null,
        imageUrls: visibleUrls,
        beforeAfterPairs: beforeAfter.length,
      },
      args.warn,
    );

    const finalScript: AdScript = { ...(shared ? { ...script, ...shared } : script), ...marks };
    shared ??= {
      voiceoverText: script.voiceoverText,
      sticker: script.sticker,
      voice: script.voice,
      photoMotions: script.photoMotions,
      openerPrompt: script.openerPrompt,
    };

    const [creative] = await db
      .insert(creatives)
      .values({
        campaignId: campaign.id,
        aspectRatio,
        script: finalScript,
        scriptSource: source,
        sourceAssetKeys: orderedKeys,
        version,
      })
      .returning();

    await enqueueRender(creative.id);
    created.push(creative);
  }

  await db
    .update(campaigns)
    .set({ status: "rendering", updatedAt: new Date() })
    .where(eq(campaigns.id, campaign.id));

  return { ok: true, creatives: created };
}

import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { assets, campaigns, creatives } from "../../db/schema.js";
import { generateScript } from "../ai/script/index.js";
import { enqueueRender } from "../../render/jobs.js";
import type { AdScript } from "../script/schema.js";

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
  warn: (msg: string, err: unknown) => void;
}): Promise<GenerateResult> {
  const { campaign, userId } = args;

  // Filtered by userId as well as by id: without it, an advertiser could
  // pass another advertiser's asset ids and have their photos rendered
  // into an ad. The ownership check is the whole point of this query.
  const ownedAssets = await db
    .select()
    .from(assets)
    .where(and(eq(assets.userId, userId), inArray(assets.id, args.assetIds)));
  if (ownedAssets.length !== args.assetIds.length) {
    return { ok: false, status: 400, body: { error: "unknown_assets" } };
  }

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
  const orderedKeys = args.assetIds.map((id) => ownedAssets.find((a) => a.id === id)!.r2Key);

  const created = [];
  // The first format's narration and sticker, shared by the others: it is
  // the same spot, so one voiceover serves every format and the renderer
  // pays for it once (render/worker.ts caches it by text). Captions stay
  // per format.
  let shared: Pick<AdScript, "voiceoverText" | "sticker"> | null = null;
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
      },
      args.warn,
    );

    const finalScript: AdScript = shared ? { ...script, ...shared } : script;
    shared ??= { voiceoverText: script.voiceoverText, sticker: script.sticker };

    const [creative] = await db
      .insert(creatives)
      .values({
        campaignId: campaign.id,
        aspectRatio,
        script: finalScript,
        scriptSource: source,
        sourceAssetKeys: orderedKeys,
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

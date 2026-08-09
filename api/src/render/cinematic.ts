import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { assets, campaigns, creatives } from "../db/schema.js";
import {
  claimNextPurchase,
  attachBrief,
  markDelivered,
  markProductionFailed,
} from "../lib/cinematic/index.js";
import { generateCinematicBrief } from "../lib/cinematic/brief.js";
import { REAL_PHOTO_CLOSE_SECONDS, type CinematicBrief } from "../lib/cinematic/policy.js";
import { addOnByKey } from "../lib/pricing/index.js";
import { cinematicProvider } from "../lib/ai/cinematic/index.js";
import { voiceProvider } from "../lib/ai/voice/index.js";
import { renderCreative, type AspectRatio } from "./ffmpeg.js";
import { creativeThumbnailKey, creativeVideoKey, getObjectBytes, putObject } from "../plugins/r2.js";
import type { AdScript } from "../lib/script/schema.js";

// Production of the paid cinematic add-on.
//
// Runs in the renderer alongside the standard queue rather than in the API, for
// the same reason everything else periodic does: this container is already
// long-lived, and the API would fire it once per replica.
//
// The two queues are separate on purpose. A standard render is free, fast and
// falls back at every step; this one costs real money per attempt, takes
// minutes, and must NOT fall back — an advertiser who paid for cinematic
// footage and silently received a Ken Burns slideshow has been sold the thing
// they specifically chose not to buy.

const WORK_ROOT = process.env.RENDER_WORK_DIR ?? join(tmpdir(), "advault-render");
const POLL_INTERVAL_MS = Number(process.env.CINEMATIC_POLL_INTERVAL_MS ?? 15_000);

function log(msg: string, extra?: unknown): void {
  console.log(JSON.stringify({ worker: "cinematic", msg, extra: extra ?? undefined }));
}

/**
 * The brief as an AdScript, so the existing renderer can encode it unchanged.
 *
 * Generated shots become scenes backed by a "motion clip"; the advertiser's own
 * photo becomes the final scene with no clip, which is the one moment in the ad
 * that is real. The end card then follows as it does everywhere else.
 */
function toAdScript(brief: CinematicBrief, closingCaption: string): AdScript {
  return {
    hook: brief.closingText.slice(0, 80),
    scenes: [
      ...brief.shots.map((shot) => ({
        // Every scene points at the real photo. Shots with a clip never read
        // it, and the closing scene is the photo itself — so a missing clip
        // degrades to the photo rather than to an undefined filename.
        assetIndex: 0,
        caption: shot.caption ?? brief.closingText,
        durationSeconds: shot.seconds,
      })),
      {
        assetIndex: 0,
        caption: closingCaption,
        durationSeconds: REAL_PHOTO_CLOSE_SECONDS,
      },
    ],
    callToAction: brief.callToAction,
    endCardText: brief.closingText,
    voiceoverText: brief.voiceoverText,
  };
}

async function produce(purchase: typeof import("../db/schema.js").purchases.$inferSelect) {
  const addOn = addOnByKey(purchase.addOnKey);
  if (!addOn) throw new Error(`unknown add-on ${purchase.addOnKey}`);

  const provider = cinematicProvider();
  if (!provider) throw new Error("no cinematic provider is configured");

  if (!purchase.campaignId) throw new Error("purchase has no campaign");
  const [campaign] = await db
    .select()
    .from(campaigns)
    .where(eq(campaigns.id, purchase.campaignId))
    .limit(1);
  if (!campaign) throw new Error("campaign no longer exists");

  // What the advertiser typed at checkout, stashed on the purchase.
  const order = (purchase.brief ?? {}) as { description?: string; aspectRatio?: AspectRatio };
  const aspectRatio: AspectRatio = order.aspectRatio ?? "9:16";
  const description = order.description ?? campaign.offerDetails ?? campaign.businessCategory;

  const photos = await db
    .select()
    .from(assets)
    .where(eq(assets.userId, purchase.userId))
    .limit(10);
  if (photos.length === 0) {
    // The guardrail in policy.ts, enforced before a single billed second: an ad
    // made entirely of generated footage is a stock-footage advertisement for a
    // business that may as well not exist.
    throw new Error("no real photo to close on");
  }

  const brief = await generateCinematicBrief(
    {
      businessName: campaign.businessName,
      businessCategory: campaign.businessCategory,
      description,
      offerDetails: campaign.offerDetails,
      callToAction: campaign.callToAction,
      aspectRatio,
      addOn,
      realAssetCount: photos.length,
    },
    log,
  );
  await attachBrief(purchase.id, { ...order, brief });

  const workDir = await mkdtemp(join(WORK_ROOT, "cine-"));
  try {
    // The advertiser's real photo, which closes the ad.
    const closingKey = photos[0].r2Key;
    const closingBytes = await getObjectBytes(closingKey);
    const closingPath = join(workDir, `real.${closingKey.split(".").pop() ?? "jpg"}`);
    await writeFile(closingPath, closingBytes);

    // Generated footage. NO try/catch per shot, unlike the motion path: a
    // missing clip there costs polish on a free render, while here it is a hole
    // in something already paid for. Fail the whole order and refund.
    const clipPaths = new Map<number, string>();
    let billedSeconds = 0;
    for (const [i, shot] of brief.shots.entries()) {
      const result = await provider.generate({
        prompt: shot.prompt,
        seconds: shot.seconds,
        aspectRatio,
      });
      const clipPath = join(workDir, `cine-${i}.mp4`);
      await writeFile(clipPath, result.videoBytes);
      clipPaths.set(i, clipPath);
      billedSeconds += result.billedSeconds;
      log("cinematic shot generated", {
        purchaseId: purchase.id,
        shot: i,
        source: result.source,
        billedSeconds: result.billedSeconds,
      });
    }

    // Our own TTS, not the vendor's native dialogue — and the renderer strips
    // vendor audio (`-an`) on purpose.
    //
    // Veo will happily invent spoken dialogue, and invented speech in a paid
    // advertisement is exactly the claim problem the visual guardrail exists to
    // prevent, just delivered through a different channel. The voiceover is the
    // one place a factual claim is allowed, so it has to come from the
    // advertiser's own words via the brief, spoken by a voice we control.
    let voicePath: string | undefined;
    const voice = voiceProvider();
    if (voice) {
      try {
        // Currency drives the accent, not the price: an Indian shop's ad must
        // not open in a US voice, which reads as "not from here" and is the
        // opposite of the product's entire pitch.
        const result = await voice.synthesize({
          text: brief.voiceoverText,
          currency: purchase.currencyCode as "INR" | "USD",
        });
        voicePath = join(workDir, "voice.mp3");
        await writeFile(voicePath, result.audioBytes);
      } catch (err) {
        // A silent cut is a degraded ad but still a cinematic one, and the
        // expensive part already succeeded. Not worth failing the order.
        log("cinematic voiceover failed; rendering silent", { purchaseId: purchase.id, err: String(err) });
        voicePath = undefined;
      }
    }

    const [creative] = await db
      .insert(creatives)
      .values({
        campaignId: campaign.id,
        aspectRatio,
        kind: "cinematic",
        purchaseId: purchase.id,
        script: toAdScript(brief, campaign.businessName),
        scriptSource: "ai",
        sourceAssetKeys: [closingKey],
        renderStatus: "rendering",
        motionSource: provider.name,
        voiceSource: voice ? voice.name : "none",
      })
      .returning();

    const output = await renderCreative({
      workDir,
      script: toAdScript(brief, campaign.businessName),
      aspectRatio,
      imagePaths: [closingPath],
      clipPaths,
      voicePath,
    });

    const videoKey = creativeVideoKey(campaign.id, creative.id);
    const thumbnailKey = creativeThumbnailKey(campaign.id, creative.id);
    const videoBytes = await readFile(output.videoPath);
    await putObject(videoKey, videoBytes, "video/mp4");
    await putObject(thumbnailKey, await readFile(output.thumbnailPath), "image/jpeg");

    await db
      .update(creatives)
      .set({
        renderStatus: "ready",
        videoKey,
        thumbnailKey,
        durationSeconds: output.durationSeconds,
        sizeBytes: videoBytes.byteLength,
      })
      .where(eq(creatives.id, creative.id));

    await markDelivered(purchase.id);
    log("cinematic ad delivered", {
      purchaseId: purchase.id,
      creativeId: creative.id,
      billedSeconds,
      sizeBytes: videoBytes.byteLength,
    });
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch((err) =>
      log("failed to clean cinematic scratch directory", String(err)),
    );
  }
}

let shuttingDown = false;

export function stopCinematicWorker(): void {
  shuttingDown = true;
}

export function startCinematicWorker(): void {
  void (async () => {
    while (!shuttingDown) {
      let purchase = null;
      try {
        purchase = await claimNextPurchase();
      } catch (err) {
        log("failed to claim a cinematic order", String(err));
      }

      if (!purchase) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        continue;
      }

      try {
        await produce(purchase);
      } catch (err) {
        const { willRetry } = await markProductionFailed({
          purchaseId: purchase.id,
          attempts: purchase.attempts,
          error: err,
        }).catch(() => ({ willRetry: false }));
        // Logged at this volume because every one of these is a customer who
        // has paid and has nothing. `willRetry: false` is a refund waiting to
        // happen and nothing else in the system will notice it.
        log("cinematic production failed", {
          purchaseId: purchase.id,
          attempts: purchase.attempts,
          willRetry,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  })();
}

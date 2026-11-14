import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { and, desc, eq } from "drizzle-orm";
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
import { enqueueYoutubeUpload } from "./youtubeJobs.js";
import { cinematicProvider } from "../lib/ai/cinematic/index.js";
import { synthesizeVoice, voiceProvider } from "../lib/ai/voice/index.js";
import { defaultVoiceFor } from "../lib/script/schema.js";
import { noteFalFailure } from "../lib/vendors/fal.js";
import { enhancePhotos } from "./enhance.js";
import { TEMPLATE_ENABLED, renderTemplate } from "./template.js";
import { extractThumbnail, renderCreative, type AspectRatio } from "./ffmpeg.js";
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
    ...(brief.sticker ? { sticker: brief.sticker } : {}),
    ...(brief.voice ? { voice: brief.voice } : {}),
  };
}

// The closing photo: the campaign's own pick (the agent's portrait, else a
// photo marked as showing people, else its first photo), from its latest
// photo ad; otherwise the advertiser's most recent photo.
async function closingPhoto(campaignId: string, userId: string): Promise<{ key: string; isPortrait: boolean } | null> {
  const [latest] = await db
    .select({ keys: creatives.sourceAssetKeys, script: creatives.script })
    .from(creatives)
    .where(and(eq(creatives.campaignId, campaignId), eq(creatives.kind, "standard")))
    .orderBy(desc(creatives.createdAt))
    .limit(1);
  if (latest?.keys.length) {
    const sc = latest.script as { portraitIndex?: number; peopleIndexes?: number[] } | null;
    if (sc?.portraitIndex != null && latest.keys[sc.portraitIndex]) {
      return { key: latest.keys[sc.portraitIndex], isPortrait: true };
    }
    const people = sc?.peopleIndexes?.find((i) => latest.keys[i]);
    return { key: latest.keys[people ?? 0], isPortrait: false };
  }
  const [photo] = await db
    .select({ key: assets.r2Key })
    .from(assets)
    .where(and(eq(assets.userId, userId), eq(assets.kind, "photo")))
    .orderBy(desc(assets.createdAt))
    .limit(1);
  return photo ? { key: photo.key, isPortrait: false } : null;
}

const FORMATS: AspectRatio[] = ["9:16", "16:9"];

async function produce(purchase: typeof import("../db/schema.js").purchases.$inferSelect) {
  const addOn = addOnByKey(purchase.addOnKey);
  if (!addOn) throw new Error(`unknown add-on ${purchase.addOnKey}`);

  const provider = cinematicProvider();
  if (!provider) throw new Error("no cinematic provider is configured");

  if (!purchase.campaignId) throw new Error("purchase has no campaign");
  const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, purchase.campaignId)).limit(1);
  if (!campaign) throw new Error("campaign no longer exists");

  // What the advertiser typed at checkout, stashed on the purchase.
  const order = (purchase.brief ?? {}) as { description?: string; brief?: CinematicBrief };
  const description = order.description ?? campaign.offerDetails ?? campaign.businessCategory;

  const closing = await closingPhoto(campaign.id, purchase.userId);
  if (!closing) {
    // The guardrail in policy.ts, enforced before a single billed second: an ad
    // made entirely of generated footage is a stock-footage advertisement for a
    // business that may as well not exist.
    throw new Error("no real photo to close on");
  }

  // A retry reuses the brief it already wrote (same shots, same narration).
  const brief =
    order.brief ??
    (await generateCinematicBrief(
      {
        businessName: campaign.businessName,
        businessCategory: campaign.businessCategory,
        description,
        offerDetails: campaign.offerDetails,
        callToAction: campaign.callToAction,
        aspectRatio: "9:16",
        addOn,
        realAssetCount: 1,
      },
      log,
    ));
  if (!order.brief) await attachBrief(purchase.id, { ...order, brief });

  const workDir = await mkdtemp(join(WORK_ROOT, "cine-"));
  try {
    const closingPath = join(workDir, `real.${closing.key.split(".").pop() ?? "jpg"}`);
    await writeFile(closingPath, await getObjectBytes(closing.key));
    // The demo "pro photo" pass on the closing photo (never a portrait).
    const enhanced = await enhancePhotos({
      campaignId: campaign.id,
      sourceAssetKeys: [closing.key],
      imagePaths: [closingPath],
      skip: closing.isPortrait ? [0] : [],
      workDir,
      log: (msg, extra) => log(msg, { purchaseId: purchase.id, ...(extra as object) }),
    });
    const imagePath = enhanced.imagePaths[0];

    // One voiceover for both formats: ElevenLabs through fal with the
    // brief's narrator. Our own TTS, never the vendor's native audio (the
    // footage is muted): invented speech in an ad is the claim problem again.
    let voicePath: string | undefined;
    let voiceSource: "fal" | "edge-tts" | "elevenlabs" | "none" = "none";
    if (voiceProvider()) {
      try {
        const result = await synthesizeVoice({
          text: brief.voiceoverText,
          currency: purchase.currencyCode as "INR" | "USD",
          voice: process.env.FAL_VOICE ?? brief.voice ?? defaultVoiceFor(campaign.businessCategory),
        });
        if (result.fellBack) noteFalFailure("cinematic voice", result.fellBack);
        voicePath = join(workDir, "voice.mp3");
        await writeFile(voicePath, result.audioBytes);
        voiceSource = result.fellBack ? "edge-tts" : result.source === "fal-elevenlabs" ? "fal" : result.source;
      } catch (err) {
        // A silent cut is a degraded ad but still a cinematic one, and the
        // expensive part already succeeded. Not worth failing the order.
        log("cinematic voiceover failed; rendering silent", { purchaseId: purchase.id, err: String(err) });
      }
    }

    // Both formats, like the photo ads (Google serves 9:16 on Shorts and
    // 16:9 in-stream). Each shot is generated per format: text-to-video
    // composes for the frame it is given. Shots in parallel, formats in turn.
    // NO per-shot fallback: a missing shot is a hole in something paid for,
    // so the whole order fails (and retries, then refunds).
    const script = toAdScript(brief, campaign.businessName);
    // A retry after one format was finished must not pay for it again or
    // leave a duplicate: keep the ready ones, delete anything half-made.
    const earlier = await db
      .select({ id: creatives.id, aspectRatio: creatives.aspectRatio, renderStatus: creatives.renderStatus })
      .from(creatives)
      .where(eq(creatives.purchaseId, purchase.id));
    const done = new Set(earlier.filter((c) => c.renderStatus === "ready").map((c) => c.aspectRatio));
    for (const c of earlier.filter((x) => x.renderStatus !== "ready")) {
      await db.delete(creatives).where(eq(creatives.id, c.id));
    }
    let billedSeconds = 0;
    for (const aspectRatio of FORMATS.filter((f) => !done.has(f))) {
      const tag = aspectRatio.replace(":", "x");
      const clipPaths = new Map<number, string>();
      await Promise.all(
        brief.shots.map(async (shot, i) => {
          const result = await provider
            .generate({ prompt: shot.prompt, seconds: shot.seconds, aspectRatio })
            .catch((err: unknown) => {
              noteFalFailure("cinematic footage", err instanceof Error ? err.message : String(err));
              throw err;
            });
          const clipPath = join(workDir, `cine-${tag}-${i}.mp4`);
          await writeFile(clipPath, result.videoBytes);
          clipPaths.set(i, clipPath);
          billedSeconds += result.billedSeconds;
          log("cinematic shot generated", { purchaseId: purchase.id, aspectRatio, shot: i, source: result.source });
        }),
      );

      const [creative] = await db
        .insert(creatives)
        .values({
          campaignId: campaign.id,
          aspectRatio,
          kind: "cinematic",
          purchaseId: purchase.id,
          script,
          scriptSource: "ai",
          sourceAssetKeys: [enhanced.keys[0]],
          renderStatus: "rendering",
          motionSource: provider.name,
          voiceSource,
        })
        .returning();

      const templated = TEMPLATE_ENABLED
        ? await renderTemplate(
            {
              workDir,
              script,
              aspectRatio,
              imagePaths: [imagePath],
              clipPaths,
              voicePath,
              businessName: campaign.businessName,
              businessCategory: campaign.businessCategory,
              landingUrl: campaign.landingUrl,
              cinematic: true,
            },
            (msg, extra) => log(msg, { purchaseId: purchase.id, ...(extra as object) }),
          )
        : null;
      let output: { videoPath: string; thumbnailPath: string; durationSeconds: number };
      if (templated) {
        const thumbnailPath = join(workDir, `thumb-${tag}.jpg`);
        await extractThumbnail(templated.videoPath, thumbnailPath);
        output = { ...templated, thumbnailPath };
      } else {
        output = await renderCreative({ workDir, script, aspectRatio, imagePaths: [imagePath], clipPaths, voicePath });
      }

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
          renderedAt: new Date(),
          renderInfo: {
            engine: templated ? "template" : "ffmpeg",
            cinematic: true,
            footage: provider.name,
            shots: brief.shots.length,
            voice: voiceSource,
            photoEnhanced: enhanced.made + enhanced.reused > 0,
            at: new Date().toISOString(),
          },
        })
        .where(eq(creatives.id, creative.id));

      // Logged, never thrown: the ad IS made, and the upload retries on its own queue.
      await enqueueYoutubeUpload(creative.id).catch((err) =>
        log("failed to enqueue the cinematic youtube upload", { creativeId: creative.id, error: String(err) }),
      );
    }

    await markDelivered(purchase.id);
    log("cinematic ad delivered", { purchaseId: purchase.id, billedSeconds });
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

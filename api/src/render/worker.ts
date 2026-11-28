// The renderer entrypoint (`advault-renderer` in Coolify, Dockerfile.renderer).
//
// Polls render_jobs, downloads the creative's source photos from R2, shells out
// to ffmpeg, uploads the result back to R2, and flips the creative's status.
// It is not an HTTP service: it exposes no port and needs no domain.
//
// It deliberately does NOT run migrations — the API container owns that. Two
// containers migrating on the same deploy race the drizzle bookkeeping table
// and the loser crash-loops.
import { showableLandingUrl } from "../lib/siteOffer/siteLink.js";
import { isReformatCopy } from "../lib/uploads/reformatPolicy.js";
import { reformatVideo } from "./reformat.js";
import { renderOfferSlide } from "./offerSlide.js";
import { slideVoice, voiceCacheKey } from "./slideVoice.js";
import { offerSlideOf } from "../lib/offerSwap/policy.js";
import { advanceOfferChangeForCreative } from "../lib/offerSwap/sweep.js";
import { notifyAdReady } from "../lib/customerEmails/index.js";
import { deleteUploadObjects } from "../lib/uploads/remove.js";
import { hostname } from "node:os";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pool } from "../db/index.js";
import {
  claimNextJob,
  completeJob,
  failJob,
  loadCreativeForRender,
  reclaimStalled,
  type RenderJob,
} from "./jobs.js";
import { extractThumbnail, FONT_BOLD, FONT_REGULAR, renderCreative, type AspectRatio } from "./ffmpeg.js";
import { TEMPLATE_ENABLED, renderTemplate } from "./template.js";
import { startSpendSync } from "./spendSync.js";
import { startAdMetricsSync } from "./adMetricsSync.js";
import { startFalBalanceWatch } from "./falBalanceWatch.js";
import { noteFalFailure } from "../lib/vendors/fal.js";
import { startPlatformBillingSweep } from "../lib/billing/managedCard.js";
import { startOfferScheduler } from "./offerCycles.js";
import { startOfferSwapSweep } from "./offerSwaps.js";
import { startCinematicWorker, stopCinematicWorker } from "./cinematic.js";
import { enqueueYoutubeUpload } from "./youtubeJobs.js";
import { startYoutubeUploadWorker, stopYoutubeUploadWorker } from "./youtubeUploads.js";
import { adScriptSchema, type AdScript } from "../lib/script/schema.js";
import { falMotionPrompt, motionIsPerFormat, motionProvider } from "../lib/ai/motion/index.js";
import { falOmni } from "../lib/ai/cinematic/index.js";
import { enhancePhotos } from "./enhance.js";
import { plainPhotoIndexes } from "../lib/beforeAfter/policy.js";
import { defaultVoiceFor } from "../lib/script/schema.js";
import { adRatingLine } from "../lib/places/index.js";
import { withEndCardLine } from "../lib/places/endCard.js";
import { DEFAULT_FAL_VOICE, synthesizeVoice, voiceProvider } from "../lib/ai/voice/index.js";
import {
  creativeThumbnailKey,
  creativeVideoKey,
  getObjectBytes,
  headObject,
  presignDownload,
  putObject,
} from "../plugins/r2.js";

// How many scenes may get an AI motion clip. This is a COST ceiling, not a
// quality one: motion clips are metered per generation and are ~95% of the
// marginal cost of producing an ad, so a five-scene script must not silently
// cost 66% more than a three-scene one. Scenes beyond the cap render as Ken
// Burns stills, which is what every ad rendered to date already looks like.
// 4 (was 3, 2026-11-16): a typical ad has 4 photo scenes, and the one left as
// a Ken Burns still stood out as "no animation".
const MOTION_MAX_CLIPS = Number(process.env.MOTION_MAX_CLIPS ?? 4);

// KEEP THIS AT 1 in production. The shared cx33 has 4 vCPUs and also runs
// Postgres, three other API containers and the whole monitoring stack; an
// unbounded ffmpeg pool is the fastest way to take the box down for four apps
// at once.
const CONCURRENCY = Number(process.env.RENDER_CONCURRENCY ?? 1);
const POLL_INTERVAL_MS = Number(process.env.RENDER_POLL_INTERVAL_MS ?? 5000);
const WORK_ROOT = process.env.RENDER_WORK_DIR ?? join(tmpdir(), "advault-render");
const WORKER_ID = `${hostname()}-${process.pid}`;

let shuttingDown = false;

function log(msg: string, extra?: unknown): void {
  // Plain stdout JSON: Alloy ships every container's stdout to Loki, so
  // structured lines here are queryable in Grafana without any per-app config.
  console.log(JSON.stringify({ worker: WORKER_ID, msg, extra: extra ?? undefined }));
}

const IMAGE_CONTENT_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

// Motion clips for as many scenes as the cost ceiling allows.
//
// Every failure path here returns fewer clips, never an error. Motion is the
// newest, slowest and only metered thing in the render path; making it
// load-bearing would make every ad only as reliable as the least reliable
// vendor, and the fallback is not a stub — it is the Ken Burns pan that
// produced every verified render to date.
async function generateMotionClips(args: {
  script: AdScript;
  sourceAssetKeys: string[];
  imagePaths: string[];
  aspectRatio: AspectRatio;
  workDir: string;
  creativeId: string;
  campaignId: string;
  /** Photo indexes that must stay plain (before & after photos): never a motion clip. */
  plain?: number[];
  /**
   * Offer-change re-cut (lib/offerSwap): may a clip that is NOT in the cache be
   * generated for this photo key? Absent = yes (an ordinary ad).
   */
  mayGenerate?: (sourceKey: string) => boolean;
}): Promise<Map<number, string>> {
  const clips = new Map<number, string>();
  const provider = motionProvider();
  if (!provider || MOTION_MAX_CLIPS <= 0) return clips;

  const reused = new Set<number>();
  const errors: string[] = [];
  // Which scenes get a clip: people first (a person moving is what makes the
  // demo ads feel alive), then the rest in order, one clip per distinct photo,
  // capped by MOTION_MAX_CLIPS. Chosen up front so the clips can be made AT THE
  // SAME TIME: each fal clip takes ~80 s, so one after another made the first
  // format wait ~4 minutes for three clips. Same cost either way.
  const people = new Set(args.script.peopleIndexes ?? []);
  const order = [...args.script.scenes.entries()].sort(
    ([, a], [, b]) => Number(people.has(b.assetIndex)) - Number(people.has(a.assetIndex)),
  );
  const picked: { i: number; scene: (typeof args.script.scenes)[number]; imagePath: string; key: string }[] = [];
  const seenKeys = new Set<string>();
  const plain = new Set(args.plain ?? []);
  for (const [i, scene] of order) {
    if (picked.length >= MOTION_MAX_CLIPS) break;
    const assetIndex = Math.min(scene.assetIndex, args.imagePaths.length - 1);
    if (plain.has(assetIndex)) continue;
    const imagePath = args.imagePaths[assetIndex];
    const key = args.sourceAssetKeys[assetIndex];
    if (!imagePath || !key || seenKeys.has(key)) continue;
    seenKeys.add(key);
    picked.push({ i, scene, imagePath, key });
  }

  await Promise.all(
    picked.map(async ({ i, scene, imagePath, key }) => {
      // A photo's fal clip depends only on the photo and its motion line
      // (shared by every format, lib/creatives/generate.ts): reuse it from R2
      // instead of paying twice.
      const motionPrompt = args.script.photoMotions?.find(
        (m) => m.assetIndex === Math.min(scene.assetIndex, args.imagePaths.length - 1),
      )?.motion;
      const clipKey =
        provider.name === "fal"
          ? `campaigns/${args.campaignId}/clips/${createHash("sha256")
              .update(
                (motionPrompt
                  ? `${key}|${process.env.FAL_MOTION_ENDPOINT ?? ""}|${falMotionPrompt(motionPrompt)}`
                  : `${key}|${process.env.FAL_MOTION_ENDPOINT ?? ""}`) +
                  // Omni clips are made for one shape; Kling's fit both.
                  (motionIsPerFormat() ? `|${args.aspectRatio}` : ""),
              )
              .digest("hex")
              .slice(0, 32)}.mp4`
          : null;
      const clipPath = join(args.workDir, `clip-${i}.mp4`);
      if (clipKey) {
        try {
          if (await headObject(clipKey)) {
            await writeFile(clipPath, await getObjectBytes(clipKey));
            clips.set(i, clipPath);
            reused.add(i);
            log("motion clip reused", { creativeId: args.creativeId, scene: i, key: clipKey });
            return;
          }
        } catch (err) {
          log("motion clip cache read failed; generating", { creativeId: args.creativeId, error: String(err) });
        }
      }
      // Re-cut: no vendor call for a photo whose clip is not cached (it plays
      // as a Ken Burns still), except the owner's one new photo when allowed.
      if (args.mayGenerate && !args.mayGenerate(key)) {
        log("motion clip not cached; re-cut keeps the still", { creativeId: args.creativeId, scene: i });
        return;
      }

      try {
        const result = await provider.generate({
          imageBytes: await readFile(imagePath),
          contentType: IMAGE_CONTENT_TYPES[key.split(".").pop() ?? ""] ?? "image/jpeg",
          // Presigned rather than public: `advault-assets` has no public read
          // access, and the Luma path needs a URL it can actually fetch.
          imageUrl: await presignDownload(key),
          prompt: scene.caption,
          motionPrompt,
          durationSeconds: scene.durationSeconds,
          aspectRatio: args.aspectRatio,
        });
        await writeFile(clipPath, result.videoBytes);
        clips.set(i, clipPath);
        if (clipKey) {
          await putObject(clipKey, result.videoBytes, "video/mp4").catch((err) =>
            log("motion clip cache write failed", { creativeId: args.creativeId, error: String(err) }),
          );
        }
        log("motion clip generated", {
          creativeId: args.creativeId,
          scene: i,
          source: result.source,
          bytes: result.videoBytes.byteLength,
        });
      } catch (err) {
        errors.push((err instanceof Error ? err.message : String(err)).slice(0, 300));
        if (provider.name === "fal") noteFalFailure("motion", err instanceof Error ? err.message : String(err));
        log("motion generation failed; scene falls back to Ken Burns", {
          creativeId: args.creativeId,
          scene: i,
          provider: provider.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }),
  );

  motionStats.set(args.creativeId, { provider: provider.name, reused: reused.size, tried: picked.length, errors });
  return clips;
}

// The mixed ad's cinematic opening shot (AD_OPENER=fal): one 5 s Omni
// text-to-video clip per format from the script's openerPrompt, cached in R2
// by prompt and shape so a redo with the same script pays nothing. Like
// motion it is polish: any failure means no opener, never a failed ad.
const AD_OPENER = process.env.AD_OPENER === "fal";
const OPENER_SECONDS = 5;
async function generateOpener(args: {
  script: AdScript;
  aspectRatio: AspectRatio;
  workDir: string;
  creativeId: string;
  campaignId: string;
  /** Offer-change re-cut: the cached opener only, never a new one. */
  cacheOnly?: boolean;
}): Promise<{ path: string; reused: boolean } | null> {
  const prompt = args.script.openerPrompt;
  if (!AD_OPENER || !prompt || !falOmni.isConfigured()) return null;
  const key = `campaigns/${args.campaignId}/opener/${createHash("sha256")
    .update(`${prompt}|${args.aspectRatio}|omni`)
    .digest("hex")
    .slice(0, 32)}.mp4`;
  const path = join(args.workDir, "opener.mp4");
  try {
    if (await headObject(key)) {
      await writeFile(path, await getObjectBytes(key));
      return { path, reused: true };
    }
  } catch (err) {
    log("opener cache read failed; generating", { creativeId: args.creativeId, error: String(err) });
  }
  if (args.cacheOnly) return null;
  try {
    const result = await falOmni.generate({ prompt, seconds: OPENER_SECONDS, aspectRatio: args.aspectRatio });
    await writeFile(path, result.videoBytes);
    await putObject(key, result.videoBytes, "video/mp4").catch((err) =>
      log("opener cache write failed", { creativeId: args.creativeId, error: String(err) }),
    );
    return { path, reused: false };
  } catch (err) {
    noteFalFailure("opener", err instanceof Error ? err.message : String(err));
    log("opener generation failed; ad starts on the photos", { creativeId: args.creativeId, error: String(err) });
    return null;
  }
}

/** The re-cut marker lib/offerSwap puts on a creative before it renders. */
function recutInfo(info: Record<string, unknown> | null | undefined): { of: string | null; allowMotionKeys: string[] } | null {
  const r = info?.recut as { of?: unknown; allowMotionKeys?: unknown } | undefined;
  if (!r || typeof r !== "object") return null;
  return {
    of: typeof r.of === "string" ? r.of : null,
    allowMotionKeys: Array.isArray(r.allowMotionKeys) ? r.allowMotionKeys.filter((k): k is string => typeof k === "string") : [],
  };
}

// Per-render facts for creatives.render_info (filled by the helpers above).
const motionStats = new Map<string, { provider: string; reused: number; tried: number; errors: string[] }>();
const voiceStats = new Map<string, string>();

// Voiceover for the whole spot, or undefined for a silent cut — which is what
// every ad rendered before this shipped already was.
// A paid voiceover is kept in R2 under the campaign, keyed by its text and
// voice, so the campaign's other format (same narration, see
// lib/creatives/generate.ts) and any redo reuse it instead of paying again.
// The key (voiceCacheKey) lives in render/slideVoice.ts, shared with the
// offer slide's voice-over.

async function synthesizeVoiceover(args: {
  script: AdScript;
  currencyCode: string;
  workDir: string;
  creativeId: string;
  campaignId: string;
  businessCategory: string;
}): Promise<string | undefined> {
  const provider = voiceProvider();
  if (!provider) return undefined;
  const voicePath = join(args.workDir, "voice.mp3");
  // The writer's pick, else one by category; FAL_VOICE pins every ad to one.
  const voice = process.env.FAL_VOICE ?? args.script.voice ?? defaultVoiceFor(args.businessCategory);
  const cacheKey = voiceCacheKey(args.campaignId, args.script.voiceoverText, voice);

  // Only paid voices are worth caching; edge-tts is free.
  if (provider.name !== "edge-tts") {
    try {
      if (await headObject(cacheKey)) {
        await writeFile(voicePath, await getObjectBytes(cacheKey));
        log("voiceover reused", { creativeId: args.creativeId, key: cacheKey });
        voiceStats.set(args.creativeId, `${provider.name} ${voice} (reused)`);
        return voicePath;
      }
    } catch (err) {
      log("voiceover cache read failed; synthesizing", { creativeId: args.creativeId, error: String(err) });
    }
  }

  try {
    // A failed paid voice falls back to edge-tts inside synthesizeVoice.
    const result = await synthesizeVoice({
      text: args.script.voiceoverText,
      currency: args.currencyCode === "INR" ? "INR" : "USD",
      voice,
    });
    if (result.fellBack) {
      log("paid voice failed; used edge-tts", { creativeId: args.creativeId, error: result.fellBack });
      noteFalFailure("voice", result.fellBack);
    }
    await writeFile(voicePath, result.audioBytes);
    voiceStats.set(args.creativeId, result.fellBack ? "edge-tts (fallback)" : `${result.source} ${voice}`);
    // A fallback (edge-tts) result is not cached, so the next format tries
    // the paid voice again.
    if (provider.name !== "edge-tts" && !result.fellBack) {
      await putObject(cacheKey, result.audioBytes, "audio/mpeg").catch((err) =>
        log("voiceover cache write failed", { creativeId: args.creativeId, error: String(err) }),
      );
    }
    log("voiceover synthesized", {
      creativeId: args.creativeId,
      source: result.source,
      bytes: result.audioBytes.byteLength,
    });
    return voicePath;
  } catch (err) {
    log("voiceover failed; rendering silent", {
      creativeId: args.creativeId,
      provider: provider.name,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

async function processJob(job: RenderJob): Promise<void> {
  const creative = await loadCreativeForRender(job.creativeId);
  if (!creative) throw new Error(`Creative ${job.creativeId} no longer exists`);
  if (creative.complianceStatus === "taken_down") {
    // AdVault removed this ad: fail it for good, no retry.
    await failJob({ ...job, attempts: job.maxAttempts }, new Error("AdVault removed this ad"));
    return;
  }
  if (creative.kind === "upload" && isReformatCopy(creative.renderInfo)) return processReformat(job, creative);
  if (creative.kind === "upload" && offerSlideOf(creative.renderInfo)) return processOfferSlide(job, creative);

  const script = adScriptSchema.parse(creative.script);
  // An offer-change re-cut (lib/offerSwap, render_info.recut): REUSE-ONLY.
  // Cached motion clips, opener and pro photos; no vendor video or image
  // call, except a motion clip for the owner's one new photo when
  // OFFER_CHANGE_PHOTO_MOTION=on. The voiceover is new (its text changed).
  const recut = recutInfo(creative.renderInfo);
  const workDir = await mkdtemp(join(WORK_ROOT, "job-"));

  try {
    // Fetched server-side with the R2 credentials rather than through a
    // presigned URL — the renderer is not a browser, and a presign round trip
    // would buy nothing but a second failure mode.
    const imagePaths: string[] = [];
    for (const [i, key] of creative.sourceAssetKeys.entries()) {
      const bytes = await getObjectBytes(key);
      // Extension preserved from the key so ffmpeg picks the right demuxer
      // instead of guessing from content.
      const ext = key.split(".").pop() ?? "jpg";
      const path = join(workDir, `source-${i}.${ext}`);
      await writeFile(path, bytes);
      imagePaths.push(path);
    }
    if (imagePaths.length === 0) throw new Error("Creative has no source assets");

    const aspectRatio = creative.aspectRatio as AspectRatio;

    // Before & after pairs (lib/beforeAfter): downloaded as they are and
    // handed straight to the layout. They never go through the photo pass or
    // motion below, so both halves of a pair get the same plain treatment.
    const beforeAfterPaths: { before: string; after: string }[] = [];
    for (const [i, pair] of (script.beforeAfter ?? []).entries()) {
      const paths = [];
      for (const [half, key] of [["before", pair.beforeKey], ["after", pair.afterKey]] as const) {
        const path = join(workDir, `ba-${i}-${half}.${key.split(".").pop() ?? "jpg"}`);
        await writeFile(path, await getObjectBytes(key));
        paths.push(path);
      }
      beforeAfterPaths.push({ before: paths[0]!, after: paths[1]! });
    }
    // The same photo in the ordinary photos too (only when every chosen photo
    // was a pair photo, lib/creatives/generate.ts): it stays plain there too.
    const plain = plainPhotoIndexes(creative.sourceAssetKeys, script.beforeAfter);

    // The demo "pro photo" pass (render/enhance.ts): brighter, sharper, tidied
    // photos for both the stills and the motion clips. Off unless
    // PHOTO_ENHANCE=fal; never the agent's portrait; failures keep originals.
    const enhanced = await enhancePhotos({
      campaignId: creative.campaignId,
      sourceAssetKeys: creative.sourceAssetKeys,
      imagePaths,
      skip: [...(script.portraitIndex != null ? [script.portraitIndex] : []), ...plain],
      cacheOnly: Boolean(recut),
      workDir,
      log: (msg, extra) => log(msg, { creativeId: creative.id, ...(extra as object) }),
    });
    imagePaths.splice(0, imagePaths.length, ...enhanced.imagePaths);

    // Both optional stages run before ffmpeg is touched, and both degrade to
    // the verified still-image pipeline rather than throwing. Sequential on
    // purpose: with RENDER_CONCURRENCY at 1 these already hold the platform's
    // only render slot, and firing several metered vendor jobs in parallel
    // multiplies the cost of a job that may still fail its encode.
    const clipPaths = await generateMotionClips({
      script,
      sourceAssetKeys: enhanced.keys,
      imagePaths,
      aspectRatio,
      workDir,
      creativeId: creative.id,
      campaignId: creative.campaignId,
      plain,
      mayGenerate: recut ? (key) => recut.allowMotionKeys.includes(key) : undefined,
    });
    // Template only: the ffmpeg fallback layout has no opener slot.
    const opener = TEMPLATE_ENABLED
      ? await generateOpener({ script, aspectRatio, workDir, creativeId: creative.id, campaignId: creative.campaignId, cacheOnly: Boolean(recut) })
      : null;

    const voicePath = await synthesizeVoiceover({
      script,
      currencyCode: creative.currencyCode,
      workDir,
      creativeId: creative.id,
      campaignId: creative.campaignId,
      businessCategory: creative.businessCategory,
    });

    // The template ad (demo look) when enabled; the ffmpeg layout otherwise,
    // and whenever the template fails.
    // "★ 4.8 on Google (120 reviews)" on the end card when the owner ticked it
    // and the rating, fetched fresh now, is 4.0+ with 5+ reviews (lib/places).
    // Any problem = no line. Template only (the ffmpeg layout has no end-card line).
    const googleLine = TEMPLATE_ENABLED ? await adRatingLine(creative.googlePlaceId, creative.showGoogleRating) : null;
    const templated = TEMPLATE_ENABLED
      ? await renderTemplate(
          {
            workDir,
            script: googleLine ? withEndCardLine(script, googleLine) : script,
            aspectRatio,
            imagePaths,
            clipPaths,
            voicePath,
            openerPath: opener?.path,
            beforeAfterPaths,
            businessName: creative.businessName,
            businessCategory: creative.businessCategory,
            landingUrl: await showableLandingUrl(creative.landingUrl),
          },
          (msg, extra) => log(msg, { creativeId: creative.id, ...(extra as object) }),
        )
      : null;
    let output: { videoPath: string; thumbnailPath: string; durationSeconds: number };
    if (templated) {
      const thumbnailPath = join(workDir, "thumbnail.jpg");
      await extractThumbnail(templated.videoPath, thumbnailPath);
      output = { ...templated, thumbnailPath };
    } else {
      output = await renderCreative({
        workDir,
        script,
        aspectRatio,
        imagePaths,
        clipPaths,
        voicePath,
        beforeAfterPaths,
      });
    }

    const videoKey = creativeVideoKey(creative.campaignId, creative.id);
    const thumbnailKey = creativeThumbnailKey(creative.campaignId, creative.id);
    const videoBytes = await readFile(output.videoPath);

    await putObject(videoKey, videoBytes, "video/mp4");
    await putObject(thumbnailKey, await readFile(output.thumbnailPath), "image/jpeg");

    const motion = motionStats.get(creative.id);
    await completeJob(job, {
      videoKey,
      thumbnailKey,
      durationSeconds: output.durationSeconds,
      sizeBytes: videoBytes.byteLength,
      renderInfo: {
        engine: templated ? "template" : "ffmpeg",
        templateEnabled: TEMPLATE_ENABLED,
        motionProvider: motion?.provider ?? null,
        motionClips: clipPaths.size,
        motionReused: motion?.reused ?? 0,
        motionTried: motion?.tried ?? 0,
        motionErrors: motion?.errors.length ? motion.errors : undefined,
        scenes: script.scenes.length,
        voice: voiceStats.get(creative.id) ?? null,
        photosEnhanced: enhanced.made + enhanced.reused,
        photosEnhancedReused: enhanced.reused,
        enhanceErrors: enhanced.errors.length ? enhanced.errors : undefined,
        perPhotoMotion: Boolean(script.photoMotions?.length),
        beforeAfterPairs: beforeAfterPaths.length || undefined,
        // Why there is no opener, when there is none: the script had no usable
        // prompt (none written, or dropped by the safety filter) vs generation failed.
        opener: opener ? (opener.reused ? "reused" : "made") : !AD_OPENER ? null : script.openerPrompt ? (recut ? "not-cached" : "failed") : "no-prompt",
        ...(recut ? { recut } : {}),
        at: new Date().toISOString(),
      },
    });
    motionStats.delete(creative.id);
    voiceStats.delete(creative.id);

    log("render complete", {
      creativeId: creative.id,
      sizeBytes: videoBytes.byteLength,
      motionClips: clipPaths.size,
      voiceover: Boolean(voicePath),
      engine: templated ? "template" : "ffmpeg",
    });

    // A rendered MP4 is not yet an ad. Google Ads video ads reference a YouTube
    // video id, so the upload is the step that turns a file into something that
    // can serve — enqueued here rather than at launch so it has already
    // happened by the time the advertiser presses the button, instead of adding
    // minutes of transfer to a request that is holding an HTTP connection.
    //
    // Enqueue failure is logged, never thrown: the render genuinely succeeded,
    // the creative is 'ready', and the upload is independently retryable from
    // POST /creatives/:id/youtube-upload.
    //
    // NOT for an offer-change re-cut: that one is a preview until the owner
    // says "Put it live", and only then is it published (lib/offerSwap
    // startPublishing). Saves the channel's small daily upload quota for
    // previews nobody approved.
    if (!recut) {
      await enqueueYoutubeUpload(creative.id).catch((err) =>
        log("failed to enqueue the youtube upload", { creativeId: creative.id, error: String(err) }),
      );
    }
  } finally {
    // Always — a scratch directory left behind on a failed render fills the
    // 75GB disk, and a full disk takes Postgres down with it, which takes all
    // four apps down. Cleanup failure is logged, never thrown: it must not mask
    // the render error that actually matters.
    await rm(workDir, { recursive: true, force: true }).catch((err) =>
      log("failed to clean scratch directory", String(err)),
    );
  }
}

/**
 * The other shape of an owner's approved upload: blurred backdrop, no AI, no
 * vendor (render/reformat.ts). Then the normal YouTube upload, like any ad.
 */
async function processReformat(
  job: RenderJob,
  creative: NonNullable<Awaited<ReturnType<typeof loadCreativeForRender>>>,
): Promise<void> {
  const sourceKey = creative.sourceAssetKeys[0];
  if (!sourceKey) throw new Error("Reformat copy has no source video");
  const workDir = await mkdtemp(join(WORK_ROOT, "job-"));
  try {
    const inputPath = join(workDir, "source.mp4");
    await writeFile(inputPath, await getObjectBytes(sourceKey));
    const out = await reformatVideo({ inputPath, aspect: creative.aspectRatio as "16:9" | "9:16", workDir });
    const videoKey = creativeVideoKey(creative.campaignId, creative.id);
    const thumbnailKey = creativeThumbnailKey(creative.campaignId, creative.id);
    const videoBytes = await readFile(out.videoPath);
    await putObject(videoKey, videoBytes, "video/mp4");
    await putObject(thumbnailKey, await readFile(out.thumbnailPath), "image/jpeg");
    const kept = await completeJob(job, {
      videoKey,
      thumbnailKey,
      durationSeconds: creative.durationSeconds ?? 0,
      sizeBytes: videoBytes.byteLength,
      renderInfo: { ...(creative.renderInfo ?? {}), at: new Date().toISOString() },
    });
    if (!kept) {
      // The copy was deleted while it rendered: the owner uploaded this shape
      // themselves (routes/uploads.ts) or removed the video. Never recreate it
      // or publish it; drop the files just written.
      await deleteUploadObjects([{ id: creative.id, videoKey, thumbnailKey }]);
      log("reformat discarded, copy was removed meanwhile", { creativeId: creative.id });
      return;
    }
    log("reformat complete", { creativeId: creative.id, aspect: creative.aspectRatio, sizeBytes: videoBytes.byteLength });
    await enqueueYoutubeUpload(creative.id).catch((err) =>
      log("failed to enqueue the youtube upload", { creativeId: creative.id, error: String(err) }),
    );
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch((err) => log("failed to clean scratch directory", String(err)));
  }
}

/**
 * An offer change on an uploaded-video ad (lib/offerSwap, render_info.engine
 * = 'offer_slide'): the owner's video + a "This month's offer" end slide,
 * read out. ffmpeg (render/offerSlide.ts) + one voice-over per change
 * (render/slideVoice.ts, R2-cached across both shapes). NOT sent to YouTube here: it
 * is a preview until "Put it live" (the swap sweep publishes it).
 */
async function processOfferSlide(
  job: RenderJob,
  creative: NonNullable<Awaited<ReturnType<typeof loadCreativeForRender>>>,
): Promise<void> {
  const slide = offerSlideOf(creative.renderInfo)!;
  const sourceKey = creative.sourceAssetKeys[0];
  if (!sourceKey) throw new Error("Offer slide has no source video");
  const workDir = await mkdtemp(join(WORK_ROOT, "job-"));
  try {
    const inputPath = join(workDir, "source.mp4");
    await writeFile(inputPath, await getObjectBytes(sourceKey));

    // The slide's voice-over (2026-11-22): the ads' voice path, one paid call
    // per change (both shapes share the R2 cache entry). Upload creatives
    // carry no voice pick, so FAL_VOICE / the provider default reads it.
    // Any failure = the old silent slide, recorded in render_info.
    const voice = await slideVoice(
      {
        campaignId: creative.campaignId,
        text: slide.narration,
        voice: process.env.FAL_VOICE ?? DEFAULT_FAL_VOICE,
        currency: creative.currencyCode === "INR" ? "INR" : "USD",
      },
      {
        providerName: () => voiceProvider()?.name ?? null,
        synthesize: synthesizeVoice,
        cacheGet: async (key) => ((await headObject(key)) ? await getObjectBytes(key) : null),
        cachePut: (key, bytes) => putObject(key, bytes, "audio/mpeg").then(() => undefined),
        log: (msg, data) => log(msg, { creativeId: creative.id, ...(data as object) }),
      },
    );
    if (voice.ok && voice.fellBack) {
      log("paid slide voice failed; used edge-tts", { creativeId: creative.id, error: voice.fellBack });
      noteFalFailure("voice", voice.fellBack);
    }
    if (!voice.ok) log("slide voice failed; slide stays silent", { creativeId: creative.id, error: voice.error });
    let voicePath: string | undefined;
    if (voice.ok) {
      voicePath = join(workDir, "slide-voice.mp3");
      await writeFile(voicePath, voice.bytes);
    }

    const out = await renderOfferSlide({
      inputPath,
      workDir,
      heading: slide.heading,
      offer: slide.offer,
      until: slide.until,
      slideSeconds: slide.seconds,
      fonts: { bold: FONT_BOLD, regular: FONT_REGULAR },
      voicePath,
    });
    const voiceInfo =
      voice.ok && out.voiceSeconds != null
        ? { voice: { provider: voice.provider, seconds: Math.round(out.voiceSeconds * 10) / 10, ...(voice.reused ? { reused: true } : {}) } }
        : { voice: null, voiceError: voice.ok ? (out.voiceError ?? "voice not used") : voice.error };
    const videoKey = creativeVideoKey(creative.campaignId, creative.id);
    const thumbnailKey = creativeThumbnailKey(creative.campaignId, creative.id);
    const videoBytes = await readFile(out.videoPath);
    await putObject(videoKey, videoBytes, "video/mp4");
    await putObject(thumbnailKey, await readFile(out.thumbnailPath), "image/jpeg");
    const kept = await completeJob(job, {
      videoKey,
      thumbnailKey,
      durationSeconds: Math.round(out.durationSeconds),
      sizeBytes: videoBytes.byteLength,
      renderInfo: {
        ...(creative.renderInfo ?? {}),
        // `seconds` stays the minimum (a retry starts from it again);
        // `renderedSeconds` is what this cut's slide actually runs.
        slide: {
          ...((creative.renderInfo as { slide?: Record<string, unknown> } | null)?.slide ?? slide),
          renderedSeconds: out.slideSeconds,
          ...voiceInfo,
        },
        at: new Date().toISOString(),
      },
    });
    if (!kept) {
      // The change was superseded or cancelled while it rendered.
      await deleteUploadObjects([{ id: creative.id, videoKey, thumbnailKey }]);
      log("offer slide discarded, its change was removed meanwhile", { creativeId: creative.id });
      return;
    }
    log("offer slide complete", { creativeId: creative.id, aspect: creative.aspectRatio, sizeBytes: videoBytes.byteLength });
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch((err) => log("failed to clean scratch directory", String(err)));
  }
}

async function runLoop(slot: number): Promise<void> {
  while (!shuttingDown) {
    let job: RenderJob | null = null;
    try {
      job = await claimNextJob(WORKER_ID);
    } catch (err) {
      // A database blip must not kill the loop — back off and try again. This
      // is also what lets the renderer start before the API has created the
      // schema on a fresh environment.
      log("failed to claim a job", String(err));
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    if (!job) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    log("claimed job", { slot, jobId: job.id, attempt: job.attempts });
    try {
      await processJob(job);
    } catch (err) {
      log("render failed", { jobId: job.id, error: String(err) });
      await failJob(job, err).catch((e) => log("failed to record job failure", String(e)));
    }
    // A cut of an offer change: move the change on now (preview ready as soon
    // as its last cut is), not at the next swap sweep. No-op otherwise; never throws.
    await advanceOfferChangeForCreative(job.creativeId);
    // "Your ad is ready" once the make's last format is done (a failed format
    // can be that last one). Background, never throws.
    notifyAdReady(job.creativeId, (m) => log(m));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(WORK_ROOT, { recursive: true });

  const reclaimed = await reclaimStalled().catch(() => 0);
  if (reclaimed > 0) log("reclaimed stalled jobs", { count: reclaimed });

  // Runs here rather than in the API: this is already a long-lived process, so
  // the job needs no new container, and the API would fire it once per replica.
  startSpendSync();
  // Read-only performance report pull for the dashboard (every launched
  // campaign, not just platform-billed ones). Network-bound, so it sits outside
  // RENDER_CONCURRENCY like the YouTube upload worker.
  startAdMetricsSync();
  // Hourly fal credit check; pages ops when the balance runs low.
  startFalBalanceWatch();
  // Polls platform accounts waiting for their card and re-alerts the operator.
  startPlatformBillingSweep();
  // Same reasoning: the monthly offer conversation, subscription renewals and
  // offer expiry are all periodic work that needs a long-lived process and must
  // fire exactly once, not once per API replica.
  startOfferScheduler();
  // "Change my offer": publish approved re-cuts, swap at Google after
  // approval, and return to the base ad on the end date (lib/offerSwap).
  startOfferSwapSweep();
  // The paid add-on queue. Separate from the render loop above because it is
  // metered per attempt and must never fall back — see render/cinematic.ts.
  startCinematicWorker();
  // The queue that makes a rendered file into an ad. Network-bound, so it runs
  // alongside the encode loop rather than inside its concurrency budget.
  startYoutubeUploadWorker();

  log("renderer started", { concurrency: CONCURRENCY, workRoot: WORK_ROOT });
  await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => runLoop(i)));
}

// Coolify sends SIGTERM on redeploy. Finishing the in-flight encode rather than
// dying mid-file means the job isn't left 'running' for the 30 minutes it takes
// reclaimStalled() to notice.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (shuttingDown) process.exit(1);
    log(`${signal} received — finishing the current job then exiting`);
    shuttingDown = true;
    stopCinematicWorker();
    stopYoutubeUploadWorker();
    void pool.end().catch(() => undefined);
  });
}

main().catch((err) => {
  log("renderer crashed", String(err));
  process.exit(1);
});

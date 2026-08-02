// The renderer entrypoint (`advault-renderer` in Coolify, Dockerfile.renderer).
//
// Polls render_jobs, downloads the creative's source photos from R2, shells out
// to ffmpeg, uploads the result back to R2, and flips the creative's status.
// It is not an HTTP service: it exposes no port and needs no domain.
//
// It deliberately does NOT run migrations — the API container owns that. Two
// containers migrating on the same deploy race the drizzle bookkeeping table
// and the loser crash-loops.
import { hostname } from "node:os";
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
import { renderCreative, type AspectRatio } from "./ffmpeg.js";
import { startSpendSync } from "./spendSync.js";
import { adScriptSchema, type AdScript } from "../lib/script/schema.js";
import { motionProvider } from "../lib/ai/motion/index.js";
import { voiceProvider } from "../lib/ai/voice/index.js";
import {
  creativeThumbnailKey,
  creativeVideoKey,
  getObjectBytes,
  presignDownload,
  putObject,
} from "../plugins/r2.js";

// How many scenes may get an AI motion clip. This is a COST ceiling, not a
// quality one: motion clips are metered per generation and are ~95% of the
// marginal cost of producing an ad, so a five-scene script must not silently
// cost 66% more than a three-scene one. Scenes beyond the cap render as Ken
// Burns stills, which is what every ad rendered to date already looks like.
const MOTION_MAX_CLIPS = Number(process.env.MOTION_MAX_CLIPS ?? 3);

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
}): Promise<Map<number, string>> {
  const clips = new Map<number, string>();
  const provider = motionProvider();
  if (!provider || MOTION_MAX_CLIPS <= 0) return clips;

  for (const [i, scene] of args.script.scenes.entries()) {
    if (clips.size >= MOTION_MAX_CLIPS) break;

    const assetIndex = Math.min(scene.assetIndex, args.imagePaths.length - 1);
    const imagePath = args.imagePaths[assetIndex];
    const key = args.sourceAssetKeys[assetIndex];
    if (!imagePath || !key) continue;

    try {
      const result = await provider.generate({
        imageBytes: await readFile(imagePath),
        contentType: IMAGE_CONTENT_TYPES[key.split(".").pop() ?? ""] ?? "image/jpeg",
        // Presigned rather than public: `advault-assets` has no public read
        // access, and the Luma path needs a URL it can actually fetch. Short
        // lived by construction — the clip is generated within one render.
        imageUrl: await presignDownload(key),
        prompt: scene.caption,
        durationSeconds: scene.durationSeconds,
        aspectRatio: args.aspectRatio,
      });

      const clipPath = join(args.workDir, `clip-${i}.mp4`);
      await writeFile(clipPath, result.videoBytes);
      clips.set(i, clipPath);
      log("motion clip generated", {
        creativeId: args.creativeId,
        scene: i,
        source: result.source,
        bytes: result.videoBytes.byteLength,
      });
    } catch (err) {
      log("motion generation failed; scene falls back to Ken Burns", {
        creativeId: args.creativeId,
        scene: i,
        provider: provider.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return clips;
}

// Voiceover for the whole spot, or undefined for a silent cut — which is what
// every ad rendered before this shipped already was.
async function synthesizeVoiceover(args: {
  script: AdScript;
  currencyCode: string;
  workDir: string;
  creativeId: string;
}): Promise<string | undefined> {
  const provider = voiceProvider();
  if (!provider) return undefined;

  try {
    const result = await provider.synthesize({
      text: args.script.voiceoverText,
      currency: args.currencyCode === "INR" ? "INR" : "USD",
    });
    const voicePath = join(args.workDir, "voice.mp3");
    await writeFile(voicePath, result.audioBytes);
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

  const script = adScriptSchema.parse(creative.script);
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

    // Both optional stages run before ffmpeg is touched, and both degrade to
    // the verified still-image pipeline rather than throwing. Sequential on
    // purpose: with RENDER_CONCURRENCY at 1 these already hold the platform's
    // only render slot, and firing several metered vendor jobs in parallel
    // multiplies the cost of a job that may still fail its encode.
    const clipPaths = await generateMotionClips({
      script,
      sourceAssetKeys: creative.sourceAssetKeys,
      imagePaths,
      aspectRatio,
      workDir,
      creativeId: creative.id,
    });

    const voicePath = await synthesizeVoiceover({
      script,
      currencyCode: creative.currencyCode,
      workDir,
      creativeId: creative.id,
    });

    const output = await renderCreative({
      workDir,
      script,
      aspectRatio,
      imagePaths,
      clipPaths,
      voicePath,
    });

    const videoKey = creativeVideoKey(creative.campaignId, creative.id);
    const thumbnailKey = creativeThumbnailKey(creative.campaignId, creative.id);
    const videoBytes = await readFile(output.videoPath);

    await putObject(videoKey, videoBytes, "video/mp4");
    await putObject(thumbnailKey, await readFile(output.thumbnailPath), "image/jpeg");

    await completeJob(job, {
      videoKey,
      thumbnailKey,
      durationSeconds: output.durationSeconds,
      sizeBytes: videoBytes.byteLength,
    });

    log("render complete", {
      creativeId: creative.id,
      sizeBytes: videoBytes.byteLength,
      motionClips: clipPaths.size,
      voiceover: Boolean(voicePath),
    });
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
    void pool.end().catch(() => undefined);
  });
}

main().catch((err) => {
  log("renderer crashed", String(err));
  process.exit(1);
});

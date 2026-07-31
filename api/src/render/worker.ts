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
import { adScriptSchema } from "../lib/script/schema.js";
import {
  creativeThumbnailKey,
  creativeVideoKey,
  getObjectBytes,
  putObject,
} from "../plugins/r2.js";

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

    const output = await renderCreative({
      workDir,
      script,
      aspectRatio: creative.aspectRatio as AspectRatio,
      imagePaths,
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

    log("render complete", { creativeId: creative.id, sizeBytes: videoBytes.byteLength });
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

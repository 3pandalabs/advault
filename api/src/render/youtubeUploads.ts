import { hostname } from "node:os";
import { getObjectBytes } from "../plugins/r2.js";
import { GoogleOAuthError } from "../lib/googleAds/oauth.js";
import { NoUploadChannel, uploadCredentialFor } from "../lib/youtube/channels.js";
import { isYouTubeConfigured } from "../lib/youtube/env.js";
import { uploadVideo, YouTubeUploadError } from "../lib/youtube/upload.js";
import {
  claimNextUploadJob,
  completeUploadJob,
  failUploadJob,
  loadCreativeForUpload,
  reclaimStalledUploads,
  type YouTubeUploadJob,
} from "./youtubeJobs.js";

// The YouTube upload loop, running inside the renderer container.
//
// It lives here for the same reason the spend sync and the offer scheduler do:
// this is already a long-lived process, so it needs no new container, and the
// API would fire it once per replica.
//
// It does NOT share the render loop's concurrency budget. RENDER_CONCURRENCY is
// 1 because ffmpeg is CPU-bound on a 4-vCPU box shared with Postgres and three
// other APIs; an upload is network-bound and holding the box's only encode slot
// while waiting on Google's socket would halve throughput for no reason.
const POLL_INTERVAL_MS = Number(process.env.YOUTUBE_POLL_INTERVAL_MS ?? 10_000);
const CONCURRENCY = Number(process.env.YOUTUBE_UPLOAD_CONCURRENCY ?? 1);
const WORKER_ID = `${hostname()}-${process.pid}-yt`;

let stopped = false;

function log(msg: string, extra?: unknown): void {
  console.log(JSON.stringify({ worker: WORKER_ID, msg, extra: extra ?? undefined }));
}

async function processJob(job: YouTubeUploadJob): Promise<void> {
  const creative = await loadCreativeForUpload(job.creativeId);
  if (!creative) throw new Error(`Creative ${job.creativeId} no longer exists`);

  // A creative can be queued for upload and then re-rendered, or have its
  // render fail on a retry. Uploading a stale or absent file would put the
  // wrong video behind a live ad, which is worse than a failed upload.
  if (creative.renderStatus !== "ready" || !creative.videoKey) {
    await failUploadJob(job, new Error("Creative has no rendered video to upload"), {
      retryable: false,
    });
    return;
  }

  // Already on YouTube. Uploading again would mint a second video id, overwrite
  // the stored one, and orphan the video that a live ad is already pointing at
  // — the ad at Google references the OLD asset, so the record and the reality
  // would disagree with nothing to reconcile them. Treated as done rather than
  // failed: the creative is published, which is what the job was asking for.
  if (creative.youtubeVideoId) {
    await completeUploadJob(job, {
      youtubeVideoId: creative.youtubeVideoId,
      source: creative.youtubeChannelSource ?? "org",
    });
    log("youtube upload skipped — creative is already published", {
      creativeId: creative.id,
      youtubeVideoId: creative.youtubeVideoId,
    });
    return;
  }

  const credential = await uploadCredentialFor(creative.userId);
  const bytes = await getObjectBytes(creative.videoKey);

  // Title and description are the advertiser's own copy. Unlisted, so this is
  // not public-facing marketing — it matters because the Google Ads UI shows
  // the YouTube title against the ad, and "creative-4f3a.mp4" there is how an
  // advertiser loses track of which ad is which.
  const title = `${creative.businessName} — ${creative.campaignName}`;
  const description = [
    creative.offerDetails ?? "",
    "",
    creative.landingUrl,
    "",
    "Produced with AdVault by 3PandaLabs.",
  ]
    .join("\n")
    .trim();

  const youtubeVideoId = await uploadVideo({
    accessToken: credential.accessToken,
    bytes,
    title,
    description,
    // YouTube policy disclosure, not a flag we get to choose: a Kling or Luma
    // clip, or a synthesised voiceover, is altered/synthetic media. The default
    // pipeline (Ken Burns stills, no voice) is neither, so this is derived from
    // what the render actually used rather than hardcoded either way.
    synthetic: creative.motionSource !== "none" || creative.voiceSource !== "none",
  });

  await completeUploadJob(job, { youtubeVideoId, source: credential.source });

  log("youtube upload complete", {
    creativeId: creative.id,
    youtubeVideoId,
    channel: credential.source,
    bytes: bytes.byteLength,
  });
}

async function runLoop(): Promise<void> {
  while (!stopped) {
    let job: YouTubeUploadJob | null = null;
    try {
      job = await claimNextUploadJob(WORKER_ID);
    } catch (err) {
      log("failed to claim an upload job", String(err));
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    if (!job) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    try {
      await processJob(job);
    } catch (err) {
      // Three failure classes, three different answers:
      //  - no channel configured at all: not the creative's fault and not
      //    fixable by retrying, but it IS fixable by an operator, so it stays
      //    retryable and the job waits in the queue for the credential.
      //  - YouTube rejected the video: permanent, and retrying burns quota.
      //  - a broken advertiser grant: permanent until they reconnect.
      const retryable =
        err instanceof NoUploadChannel
          ? true
          : err instanceof YouTubeUploadError
            ? err.retryable
            : err instanceof GoogleOAuthError && err.code === "invalid_grant"
              ? false
              : true;

      log("youtube upload failed", {
        jobId: job.id,
        creativeId: job.creativeId,
        retryable,
        error: String(err),
      });
      await failUploadJob(job, err, { retryable }).catch((e) =>
        log("failed to record upload failure", String(e)),
      );
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function startYoutubeUploadWorker(): void {
  if (!isYouTubeConfigured()) {
    // Said out loud on every boot, because this is the difference between "ads
    // are being produced" and "ads are being produced and can never serve".
    // The queue keeps filling either way; nothing drains it.
    log("youtube uploads disabled — no OAuth client configured; campaigns cannot serve");
    return;
  }

  void reclaimStalledUploads()
    .then((n) => {
      if (n > 0) log("reclaimed stalled uploads", { count: n });
    })
    .catch(() => undefined);

  for (let i = 0; i < CONCURRENCY; i += 1) void runLoop();
  log("youtube upload worker started", { concurrency: CONCURRENCY });
}

export function stopYoutubeUploadWorker(): void {
  stopped = true;
}

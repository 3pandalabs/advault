import { eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { campaigns, creatives, youtubeUploadJobs } from "../db/schema.js";
import type { ChannelSource } from "../lib/youtube/channels.js";

// The YouTube upload queue. Same mechanics as render/jobs.ts — a Postgres table
// claimed with FOR UPDATE SKIP LOCKED — and deliberately a separate queue, not
// a step inside the render job: an upload must stay retryable long after its
// render finished, because an advertiser can connect their own channel months
// later and expect the back catalogue to move without re-encoding anything.

export type YouTubeUploadJob = {
  id: string;
  creativeId: string;
  attempts: number;
  maxAttempts: number;
};

// Idempotent by the partial unique index on (creative_id) WHERE status in
// ('queued','running'). Two concurrent uploads of one creative would publish
// the same ad twice and leave the loser's video id orphaned on the channel,
// counting against a daily upload quota that is small on a fresh channel.
export async function enqueueYoutubeUpload(creativeId: string): Promise<void> {
  await db.insert(youtubeUploadJobs).values({ creativeId }).onConflictDoNothing();

  // Back to 'pending' so a re-queued creative doesn't keep showing the error
  // from the attempt before it.
  await db
    .update(creatives)
    .set({ youtubeUploadStatus: "pending", youtubeUploadError: null })
    .where(eq(creatives.id, creativeId));
}

export async function claimNextUploadJob(workerId: string): Promise<YouTubeUploadJob | null> {
  const result = await db.execute<{
    id: string;
    creative_id: string;
    attempts: number;
    max_attempts: number;
  }>(sql`
    with claimed as (
      select id
      from youtube_upload_jobs
      where status = 'queued' and run_after <= now()
      order by run_after
      for update skip locked
      limit 1
    )
    update youtube_upload_jobs j
       set status = 'running',
           attempts = j.attempts + 1,
           claimed_by = ${workerId},
           claimed_at = now(),
           updated_at = now()
      from claimed
     where j.id = claimed.id
    returning j.id, j.creative_id, j.attempts, j.max_attempts
  `);

  const row = result.rows[0];
  if (!row) return null;

  await db
    .update(creatives)
    .set({ youtubeUploadStatus: "uploading", youtubeUploadError: null })
    .where(eq(creatives.id, row.creative_id));

  return {
    id: row.id,
    creativeId: row.creative_id,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
  };
}

export async function completeUploadJob(
  job: YouTubeUploadJob,
  result: { youtubeVideoId: string; source: ChannelSource },
): Promise<void> {
  await db
    .update(youtubeUploadJobs)
    .set({ status: "done", updatedAt: new Date() })
    .where(eq(youtubeUploadJobs.id, job.id));

  await db
    .update(creatives)
    .set({
      youtubeVideoId: result.youtubeVideoId,
      youtubeUploadStatus: "done",
      youtubeUploadError: null,
      youtubeChannelSource: result.source,
    })
    .where(eq(creatives.id, job.creativeId));
}

// Same exponential backoff as the render queue, with one difference that
// matters: `retryable: false` exhausts the job immediately. A video YouTube has
// rejected — wrong format, a copyright claim on the audio, a disabled channel —
// will be rejected identically on every retry, and retrying burns a daily
// upload quota that is as low as ~6 on an unverified channel.
export async function failUploadJob(
  job: YouTubeUploadJob,
  error: unknown,
  opts: { retryable?: boolean } = {},
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const exhausted = opts.retryable === false || job.attempts >= job.maxAttempts;

  if (exhausted) {
    await db
      .update(youtubeUploadJobs)
      .set({ status: "failed", lastError: message, updatedAt: new Date() })
      .where(eq(youtubeUploadJobs.id, job.id));

    await db
      .update(creatives)
      .set({ youtubeUploadStatus: "failed", youtubeUploadError: message })
      .where(eq(creatives.id, job.creativeId));
    return;
  }

  // Longer than the render queue's: a YouTube failure is usually a quota or a
  // rate limit rather than a blip, and hammering it makes the wait worse.
  const delaySeconds = Math.min(120 * 2 ** (job.attempts - 1), 1800);
  await db
    .update(youtubeUploadJobs)
    .set({
      status: "queued",
      lastError: message,
      claimedBy: null,
      claimedAt: null,
      runAfter: sql`now() + ${`${delaySeconds} seconds`}::interval`,
      updatedAt: new Date(),
    })
    .where(eq(youtubeUploadJobs.id, job.id));

  await db
    .update(creatives)
    .set({ youtubeUploadStatus: "pending", youtubeUploadError: message })
    .where(eq(creatives.id, job.creativeId));
}

// Requeues uploads whose worker died mid-transfer. `attempts` is not reset, so
// a creative that reliably kills its worker still exhausts its retries.
export async function reclaimStalledUploads(olderThanMinutes = 30): Promise<number> {
  const result = await db.execute<{ id: string }>(sql`
    update youtube_upload_jobs
       set status = 'queued',
           claimed_by = null,
           claimed_at = null,
           run_after = now(),
           last_error = coalesce(last_error, 'reclaimed after a stalled upload'),
           updated_at = now()
     where status = 'running'
       and claimed_at < now() - ${`${olderThanMinutes} minutes`}::interval
    returning id
  `);
  return result.rows.length;
}

// Everything the uploader needs in one round trip: the MP4's R2 key, who owns
// it (which channel it belongs on), the copy for the YouTube title and
// description, and whether the render used an AI motion or voice provider —
// that last one drives the containsSyntheticMedia disclosure, which is a
// YouTube policy requirement rather than a nicety.
export async function loadCreativeForUpload(creativeId: string) {
  const [row] = await db
    .select({
      id: creatives.id,
      campaignId: creatives.campaignId,
      userId: campaigns.userId,
      videoKey: creatives.videoKey,
      renderStatus: creatives.renderStatus,
      // Read so the worker can refuse to publish a creative twice — see the
      // already-published guard in youtubeUploads.ts.
      youtubeVideoId: creatives.youtubeVideoId,
      youtubeChannelSource: creatives.youtubeChannelSource,
      motionSource: creatives.motionSource,
      voiceSource: creatives.voiceSource,
      businessName: campaigns.businessName,
      campaignName: campaigns.name,
      offerDetails: campaigns.offerDetails,
      landingUrl: campaigns.landingUrl,
    })
    .from(creatives)
    .innerJoin(campaigns, eq(creatives.campaignId, campaigns.id))
    .where(eq(creatives.id, creativeId))
    .limit(1);
  return row ?? null;
}

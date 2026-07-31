import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { creatives, renderJobs } from "../db/schema.js";

// The render queue. A Postgres table rather than Redis or Temporal: the only
// async work in this app is "encode this creative", the API and the renderer
// already share a database, and `FOR UPDATE SKIP LOCKED` is a correct
// multi-consumer queue with no extra infrastructure to run, back up or monitor.

export type RenderJob = {
  id: string;
  creativeId: string;
  attempts: number;
  maxAttempts: number;
};

// Enqueue is idempotent by way of the partial unique index on
// (creative_id) WHERE status in ('queued','running'): a double-enqueue — an
// impatient advertiser, a retried request — does nothing rather than becoming
// two encodes of the same video.
export async function enqueueRender(creativeId: string): Promise<void> {
  await db.insert(renderJobs).values({ creativeId }).onConflictDoNothing();
}

// Claims one job atomically.
//
// The CTE is load-bearing. `FOR UPDATE SKIP LOCKED` makes each concurrent
// worker take a *different* row instead of blocking on the same one — replace
// this with a plain SELECT followed by an UPDATE and the moment a second
// renderer replica exists, two workers encode the same creative and the later
// R2 PUT silently wins.
//
// `run_after <= now()` does double duty: it is the retry backoff, and it is the
// crash-recovery mechanism. A job whose worker died stays 'running' with a
// stale claim; reclaimStalled() below puts it back in the queue without a
// separate reaper process.
export async function claimNextJob(workerId: string): Promise<RenderJob | null> {
  const result = await db.execute<{
    id: string;
    creative_id: string;
    attempts: number;
    max_attempts: number;
  }>(sql`
    with claimed as (
      select id
      from render_jobs
      where status = 'queued' and run_after <= now()
      order by run_after
      for update skip locked
      limit 1
    )
    update render_jobs j
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
    .set({ renderStatus: "rendering", renderError: null })
    .where(eq(creatives.id, row.creative_id));

  return {
    id: row.id,
    creativeId: row.creative_id,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
  };
}

export async function completeJob(
  job: RenderJob,
  result: { videoKey: string; thumbnailKey: string; durationSeconds: number; sizeBytes: number },
): Promise<void> {
  await db
    .update(renderJobs)
    .set({ status: "done", updatedAt: new Date() })
    .where(eq(renderJobs.id, job.id));

  await db
    .update(creatives)
    .set({
      renderStatus: "ready",
      renderError: null,
      videoKey: result.videoKey,
      thumbnailKey: result.thumbnailKey,
      durationSeconds: result.durationSeconds,
      sizeBytes: result.sizeBytes,
      renderedAt: new Date(),
    })
    .where(eq(creatives.id, job.creativeId));
}

// Exponential backoff, capped. A transient failure (R2 blip, a source photo
// still propagating) should retry; a genuinely bad input should stop consuming
// a CPU core on a shared box after three attempts and surface the error to the
// advertiser instead.
export async function failJob(job: RenderJob, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const exhausted = job.attempts >= job.maxAttempts;

  if (exhausted) {
    await db
      .update(renderJobs)
      .set({ status: "failed", lastError: message, updatedAt: new Date() })
      .where(eq(renderJobs.id, job.id));

    await db
      .update(creatives)
      .set({ renderStatus: "failed", renderError: message })
      .where(eq(creatives.id, job.creativeId));
    return;
  }

  const delaySeconds = Math.min(30 * 2 ** (job.attempts - 1), 300);
  await db
    .update(renderJobs)
    .set({
      status: "queued",
      lastError: message,
      claimedBy: null,
      claimedAt: null,
      runAfter: sql`now() + ${`${delaySeconds} seconds`}::interval`,
      updatedAt: new Date(),
    })
    .where(eq(renderJobs.id, job.id));

  // Back to 'queued' rather than 'failed': the dashboard shows "rendering"
  // through a retry, which is what is actually happening.
  await db
    .update(creatives)
    .set({ renderStatus: "queued", renderError: message })
    .where(eq(creatives.id, job.creativeId));
}

// Requeues jobs whose worker died mid-encode — a container restart, an OOM
// kill, a deploy. Runs on worker startup and periodically. `attempts` is not
// reset, so a job that reliably kills its worker still exhausts its retries
// instead of crash-looping the renderer forever.
export async function reclaimStalled(olderThanMinutes = 30): Promise<number> {
  const result = await db.execute<{ id: string }>(sql`
    update render_jobs
       set status = 'queued',
           claimed_by = null,
           claimed_at = null,
           run_after = now(),
           last_error = coalesce(last_error, 'reclaimed after a stalled render'),
           updated_at = now()
     where status = 'running'
       and claimed_at < now() - ${`${olderThanMinutes} minutes`}::interval
    returning id
  `);
  return result.rows.length;
}

export async function loadCreativeForRender(creativeId: string) {
  const [row] = await db
    .select()
    .from(creatives)
    .where(and(eq(creatives.id, creativeId)))
    .limit(1);
  return row ?? null;
}

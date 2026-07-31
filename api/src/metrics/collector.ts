// In-process counters backing GET /metrics. Everything here lives in memory and
// resets when the container restarts — that is deliberate: an ops dashboard does
// not justify a metrics store, and nothing here is worth persisting.
//
// Kept byte-for-byte in step with the same file in the other 3PandaLabs apps.
// The admin page's rendering script is fully generic over the shared envelope,
// so a local "improvement" here becomes a per-app special case there.

const BUCKET_COUNT = 60;

// Ring of one-minute buckets. `bucketMinute` records which absolute minute each
// slot currently holds so a stale slot from the previous lap is ignored rather
// than counted again an hour later.
const buckets = new Array<number>(BUCKET_COUNT).fill(0);
const bucketMinute = new Array<number>(BUCKET_COUNT).fill(-1);

export function recordRequest(at: number = Date.now()): void {
  const minute = Math.floor(at / 60_000);
  const slot = minute % BUCKET_COUNT;
  if (bucketMinute[slot] !== minute) {
    bucketMinute[slot] = minute;
    buckets[slot] = 0;
  }
  buckets[slot] += 1;
}

export function requestsLastHour(now: number = Date.now()): number {
  const minute = Math.floor(now / 60_000);
  let total = 0;
  for (let slot = 0; slot < BUCKET_COUNT; slot += 1) {
    const held = bucketMinute[slot];
    if (held >= 0 && minute - held < BUCKET_COUNT) total += buckets[slot];
  }
  return total;
}

// Sampled CPU share, expressed as a percentage of ONE core — so a box with 4
// vCPUs can legitimately report up to 400%.
let cpuPercent = 0;
let lastSample = process.cpuUsage();
let lastSampleAt = Date.now();

export function startCpuSampler(intervalMs = 15_000): void {
  const timer = setInterval(() => {
    const used = process.cpuUsage(lastSample);
    const now = Date.now();
    const elapsedMicros = (now - lastSampleAt) * 1000;
    lastSample = process.cpuUsage();
    lastSampleAt = now;
    if (elapsedMicros > 0) {
      cpuPercent = ((used.user + used.system) / elapsedMicros) * 100;
    }
  }, intervalMs);
  // Never hold the process open just to keep sampling.
  timer.unref();
}

export function cpuPercentOfOneCore(): number {
  return Math.round(cpuPercent * 10) / 10;
}

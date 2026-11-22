// An honest time-based progress estimate (the renderer reports no progress,
// only "done"). Time-based, so it survives a page refresh: the start comes
// from the API (e.g. an offer change's createdAt). Never 100% on its own;
// it holds at 95% until the real status says ready.

export const ESTIMATE_HOLD = 0.95;

/** 0..0.95 of the way through `expectedSeconds` since `startedMs`. */
export function estimateFraction(startedMs: number, nowMs: number, expectedSeconds: number): number {
  if (!Number.isFinite(startedMs) || expectedSeconds <= 0) return 0;
  const elapsed = Math.max(0, (nowMs - startedMs) / 1000);
  return Math.min(ESTIMATE_HOLD, elapsed / expectedSeconds);
}

/** True once the expected time is up (the bar holds and says "checking"). */
export function estimateOverdue(startedMs: number, nowMs: number, expectedSeconds: number): boolean {
  return (nowMs - startedMs) / 1000 >= expectedSeconds;
}

/** "about 1 minute" / "about 4 minutes" (always at least a minute). */
export function aboutMinutes(seconds: number): string {
  const m = Math.max(1, Math.round(seconds / 60));
  return `about ${m} minute${m === 1 ? "" : "s"}`;
}

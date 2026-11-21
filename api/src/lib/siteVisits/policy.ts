// Ad click tracking, pure half (2026-11-21, migration 0045). See
// lib/siteVisits/index.ts and CLAUDE.md "Ad click tracking".

/** utm_campaign values we count: AdVault campaign ids are uuids, nothing else is ours. */
export const CAMPAIGN_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isCampaignId(v: unknown): v is string {
  return typeof v === "string" && CAMPAIGN_ID_RE.test(v);
}

/** The only host whose visits AdVault can see (our own web app). */
export const ADVAULT_SITE_HOST = "advault.3pandalabs.com";

/** Does this ad land on our own site, so its visit count means something to the customer? */
export function landsOnAdvault(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    return new URL(url).hostname.toLowerCase() === ADVAULT_SITE_HOST;
  } catch {
    return false;
  }
}

const MAX_PATH = 120;

/**
 * The path as stored: pathname only (no query string, no fragment, so nothing
 * a visitor typed into a URL is kept), plain characters, at most 120 long.
 * Anything odd collapses to "/".
 */
export function normalisePath(raw: unknown): string {
  if (typeof raw !== "string") return "/";
  const p = raw.split(/[?#]/, 1)[0] ?? "";
  if (!p.startsWith("/") || !/^\/[A-Za-z0-9/_.\-]*$/.test(p)) return "/";
  return p.slice(0, MAX_PATH);
}

/** Visits counted per campaign per day at most (bounds rows and abuse). */
export const MAX_VISITS_PER_CAMPAIGN_DAY = 2000;

/** Per-IP cap on POST /track/visit, held in memory only (never stored). */
export const VISITS_PER_IP_PER_HOUR = 30;
const WINDOW_MS = 60 * 60 * 1000;
const MAX_TRACKED_IPS = 10_000;

/**
 * Fixed-window, in-memory limiter. The IP is a Map key for at most an hour
 * and is never written to the database or logs by this module.
 */
export function createIpLimiter(limit = VISITS_PER_IP_PER_HOUR, windowMs = WINDOW_MS) {
  const seen = new Map<string, { start: number; n: number }>();
  return function allow(ip: string, now = Date.now()): boolean {
    if (seen.size > MAX_TRACKED_IPS) {
      for (const [k, v] of seen) if (now - v.start >= windowMs) seen.delete(k);
      if (seen.size > MAX_TRACKED_IPS) seen.clear();
    }
    const cur = seen.get(ip);
    if (!cur || now - cur.start >= windowMs) {
      seen.set(ip, { start: now, n: 1 });
      return true;
    }
    if (cur.n >= limit) return false;
    cur.n += 1;
    return true;
  };
}

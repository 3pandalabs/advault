// UTM tags on the ad's final URL (2026-11-21). Every NEW launch appends
// utm_source=youtube&utm_medium=paid_video&utm_campaign=<advault campaign id>
// so a click can be told apart from other traffic: on the customer's own site
// by their analytics, and on advault.3pandalabs.com by our own first-party
// visit counter (POST /track/visit, lib/siteVisits). Ads already live keep the
// URL they were launched with; nothing re-mutates them.
//
// The original URL is kept byte for byte: the tags are appended as text before
// any #fragment rather than re-serialised through URLSearchParams (which would
// re-encode the customer's own parameters). A tag the URL already carries
// (e.g. the customer's own utm_source) is left alone, never duplicated.

export const AD_UTM_SOURCE = "youtube";
export const AD_UTM_MEDIUM = "paid_video";

export function withAdUtm(url: string, campaignId: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url; // not a URL we can reason about: launch it untouched
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return url;

  const wanted: [string, string][] = [
    ["utm_source", AD_UTM_SOURCE],
    ["utm_medium", AD_UTM_MEDIUM],
    ["utm_campaign", campaignId],
  ];
  const missing = wanted.filter(([k]) => !parsed.searchParams.has(k));
  if (missing.length === 0) return url;

  const hashAt = url.indexOf("#");
  const base = hashAt === -1 ? url : url.slice(0, hashAt);
  const fragment = hashAt === -1 ? "" : url.slice(hashAt);
  const extra = missing.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  const sep = !base.includes("?") ? "?" : base.endsWith("?") || base.endsWith("&") ? "" : "&";
  return `${base}${sep}${extra}${fragment}`;
}

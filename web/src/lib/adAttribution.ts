"use client";

import { API_URL } from "@/lib/api/browser";

// Ad click tracking (2026-11-21, api migration 0045, lib/siteVisits). Every
// new launch's final URL carries utm_campaign=<AdVault campaign id>. When a
// page here loads with one, we report the visit ONCE per browser session
// (POST /track/visit) and remember the id for 30 days, so a sign-up in that
// time can say which ad brought it (POST /auth/register adCampaignId).
// localStorage / sessionStorage only, never a cookie; every access is wrapped,
// because private windows and blocked storage throw.

const CAMPAIGN_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = "av_ad_campaign";
const SESSION_PREFIX = "av_ad_visit_";
export const AD_ATTRIBUTION_DAYS = 30;

/** The utm_campaign of this URL, when it is an AdVault campaign id. */
export function campaignIdFromSearch(search: string): string | null {
  try {
    const v = new URLSearchParams(search).get("utm_campaign");
    return v && CAMPAIGN_ID_RE.test(v) ? v.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Call on page load: counts the visit once per session and remembers the id. */
export function trackAdVisit(): void {
  if (typeof window === "undefined") return;
  const id = campaignIdFromSearch(window.location.search);
  if (!id) return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ id, at: Date.now() }));
  } catch {
    // storage blocked: sign-up attribution is simply skipped
  }
  try {
    if (window.sessionStorage.getItem(SESSION_PREFIX + id)) return;
    window.sessionStorage.setItem(SESSION_PREFIX + id, "1");
  } catch {
    // no session storage: the API's own caps still bound repeats
  }
  void fetch(`${API_URL}/track/visit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ campaignId: id, path: window.location.pathname }),
    keepalive: true,
  }).catch(() => {});
}

/** The campaign that brought this browser here in the last 30 days, if any. */
export function rememberedAdCampaignId(now = Date.now()): string | undefined {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return undefined;
    const v = JSON.parse(raw) as { id?: unknown; at?: unknown };
    if (typeof v.id !== "string" || !CAMPAIGN_ID_RE.test(v.id) || typeof v.at !== "number") return undefined;
    if (now - v.at > AD_ATTRIBUTION_DAYS * 86_400_000) {
      window.localStorage.removeItem(KEY);
      return undefined;
    }
    return v.id;
  } catch {
    return undefined;
  }
}

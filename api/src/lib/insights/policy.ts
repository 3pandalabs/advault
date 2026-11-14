// Customer groups for the admin Business page (GET /admin/business). Pure, so
// it is tested without a database; routes/adminInsights.ts gathers the facts.

export type CustomerFacts = {
  createdAt: Date;
  photos: number;
  campaigns: number;
  adsMade: number;
  paidAds: number;
  launched: number;
  liveNow: number;
  /** Distinct calendar months in the last 90 days with a paid ad, a paid invoice or a launch. */
  activeMonths90d: number;
  lastActivityAt: Date | null;
};

export const SEGMENTS = {
  regular: { label: "Regular", hint: "Paid or launched in 2+ of the last 3 months" },
  live: { label: "Live", hint: "Has a campaign running now" },
  paused: { label: "Paused", hint: "Launched before, nothing live now, active in the last 60 days" },
  lapsed: { label: "Lapsed", hint: "Launched before, nothing in the last 60 days" },
  trying: { label: "Trying", hint: "Made or paid for an ad, never launched" },
  new: { label: "New", hint: "Signed up in the last 30 days, no ad yet" },
  stalled: { label: "Stalled", hint: "Uploaded photos or started a campaign, no ad, 30+ days" },
  never_started: { label: "Never started", hint: "Signed up 30+ days ago, nothing uploaded" },
} as const;
export type Segment = keyof typeof SEGMENTS;

const DAY = 24 * 60 * 60 * 1000;

/** One group per customer, first match wins (most valuable first). */
export function segmentOf(f: CustomerFacts, now: Date = new Date()): Segment {
  if (f.activeMonths90d >= 2) return "regular";
  if (f.liveNow > 0) return "live";
  if (f.launched > 0) {
    const recent = f.lastActivityAt && now.getTime() - f.lastActivityAt.getTime() <= 60 * DAY;
    return recent ? "paused" : "lapsed";
  }
  if (f.adsMade > 0 || f.paidAds > 0) return "trying";
  if (now.getTime() - f.createdAt.getTime() <= 30 * DAY) return "new";
  if (f.photos > 0 || f.campaigns > 0) return "stalled";
  return "never_started";
}

// Puts the ad video on the campaign's SiteVault website after launch.
// Fire-and-forget from launch (a SiteVault failure never fails a launch), and
// the API sweep retries every 10 minutes, up to SITE_VIDEO_MAX_ATTEMPTS.
// Rules in policy.ts.

import { and, desc, eq, isNull, lt, ne, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { campaigns, creatives } from "../../db/schema.js";
import { getObjectBytes } from "../../plugins/r2.js";
import { setSitevaultVideo, slugFromSiteUrl } from "../sitevault/index.js";
import { pickSiteVideo, siteVideoDue, SITE_VIDEO_MAX_ATTEMPTS, SITE_VIDEO_MAX_BYTES } from "./policy.js";

export async function pushSiteVideo(campaignId: string): Promise<"pushed" | "failed" | "skipped"> {
  const [c] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
  if (!c || !siteVideoDue(c)) return "skipped";
  const fail = async (error: string) => {
    await db
      .update(campaigns)
      .set({ siteVideoAttempts: sql`${campaigns.siteVideoAttempts} + 1`, siteVideoError: error.slice(0, 300) })
      .where(eq(campaigns.id, campaignId));
    console.error(JSON.stringify({ msg: "site video push failed", campaignId, error }));
    return "failed" as const;
  };
  const slug = slugFromSiteUrl(c.landingUrl);
  if (!slug) return fail("not_a_sitevault_site");
  // A generated ad first; a campaign that only has the owner's own video uses
  // that (approved by an AdVault admin only: it goes on our domain).
  const rows = await db
    .select({ aspectRatio: creatives.aspectRatio, videoKey: creatives.videoKey, sizeBytes: creatives.sizeBytes })
    .from(creatives)
    // Never an offer-change re-cut (lib/offerSwap): the launch cut goes on the site.
    .where(and(eq(creatives.campaignId, campaignId), ne(creatives.kind, "upload"), eq(creatives.renderStatus, "ready"), isNull(creatives.offerChangeId)))
    .orderBy(desc(creatives.createdAt));
  const ad = pickSiteVideo(rows) ?? pickSiteVideo(await approvedUploads(campaignId));
  if (!ad?.videoKey) return fail("no_ready_video");
  try {
    const bytes = await getObjectBytes(ad.videoKey);
    if (bytes.length > SITE_VIDEO_MAX_BYTES) return fail("video_too_large");
    const r = await setSitevaultVideo(slug, { bytes });
    if (!r.ok) return fail(r.error);
  } catch (err) {
    return fail(String(err));
  }
  await db
    .update(campaigns)
    .set({ siteVideoPushedAt: new Date(), siteVideoError: null })
    .where(eq(campaigns.id, campaignId));
  return "pushed";
}

/** The owner's own uploaded videos that an admin approved, newest first. */
async function approvedUploads(campaignId: string) {
  return db
    .select({ aspectRatio: creatives.aspectRatio, videoKey: creatives.videoKey, sizeBytes: creatives.sizeBytes })
    .from(creatives)
    .where(
      and(
        eq(creatives.campaignId, campaignId),
        eq(creatives.kind, "upload"),
        eq(creatives.renderStatus, "ready"),
        eq(creatives.reviewStatus, "approved"),
      ),
    )
    .orderBy(desc(creatives.createdAt));
}

/**
 * For a website made from a campaign with no photos (the owner used their own
 * video): their approved video goes on the site straight away, since it is
 * theirs and the site has nothing else to show. Null when there is none yet.
 */
export async function ownVideoForNewSite(campaignId: string): Promise<{ bytes: Buffer } | null> {
  const ad = pickSiteVideo(await approvedUploads(campaignId));
  if (!ad?.videoKey) return null;
  try {
    const bytes = await getObjectBytes(ad.videoKey);
    return bytes.length <= SITE_VIDEO_MAX_BYTES ? { bytes } : null;
  } catch {
    return null;
  }
}

/** After launch: never awaited by the launch path. */
export function pushSiteVideoSoon(campaignId: string): void {
  setImmediate(() => void pushSiteVideo(campaignId).catch(() => undefined));
}

export async function runSiteVideoSweep(): Promise<{ pushed: number; failed: number }> {
  const due = await db
    .select({ id: campaigns.id })
    .from(campaigns)
    .where(
      and(
        eq(campaigns.siteVideoWanted, true),
        isNull(campaigns.siteVideoPushedAt),
        lt(campaigns.siteVideoAttempts, SITE_VIDEO_MAX_ATTEMPTS),
      ),
    )
    .limit(20);
  let pushed = 0;
  let failed = 0;
  for (const { id } of due) {
    const r = await pushSiteVideo(id);
    if (r === "pushed") pushed += 1;
    else if (r === "failed") failed += 1;
  }
  return { pushed, failed };
}

/** Every 10 minutes in the API (the only process holding SITEVAULT_INTERNAL_TOKEN). */
export function startSiteVideoSweep(intervalMs = 10 * 60 * 1000): void {
  const tick = () =>
    runSiteVideoSweep()
      .then((r) => {
        if (r.pushed || r.failed) console.log(JSON.stringify({ msg: "site video sweep", ...r }));
      })
      .catch((err) => console.error(JSON.stringify({ msg: "site video sweep threw", error: String(err) })));
  setInterval(tick, intervalMs).unref();
}

import { and, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { campaignSiteVisits, campaigns, users } from "../../db/schema.js";
import { isCampaignId, MAX_VISITS_PER_CAMPAIGN_DAY, normalisePath } from "./policy.js";

// Ad click tracking, I/O half (2026-11-21, migration 0045). A visit that
// arrives on advault.3pandalabs.com with utm_campaign=<campaign id> (added to
// every new launch's final URL by lib/googleAds/utm) is counted here, and a
// sign-up within 30 days records that campaign on the user row. No IP, no
// user agent, no visitor id is stored.

/** The campaign id, if it is one of ours; otherwise null (unknown ids are ignored). */
export async function knownCampaignId(raw: unknown): Promise<string | null> {
  if (!isCampaignId(raw)) return null;
  const id = raw.toLowerCase();
  const [row] = await db.select({ id: campaigns.id }).from(campaigns).where(eq(campaigns.id, id)).limit(1);
  return row?.id ?? null;
}

/** Counts one visit. false = ignored (unknown campaign, or today's cap reached). */
export async function recordSiteVisit(rawCampaignId: unknown, rawPath: unknown, now = new Date()): Promise<boolean> {
  const campaignId = await knownCampaignId(rawCampaignId);
  if (!campaignId) return false;
  const day = now.toISOString().slice(0, 10);
  const path = normalisePath(rawPath);

  const [today] = await db
    .select({ n: sql<number>`coalesce(sum(${campaignSiteVisits.visits}), 0)::int` })
    .from(campaignSiteVisits)
    .where(and(eq(campaignSiteVisits.campaignId, campaignId), eq(campaignSiteVisits.day, day)));
  if ((today?.n ?? 0) >= MAX_VISITS_PER_CAMPAIGN_DAY) return false;

  await db
    .insert(campaignSiteVisits)
    .values({ campaignId, day, path, visits: 1 })
    .onConflictDoUpdate({
      target: [campaignSiteVisits.campaignId, campaignSiteVisits.day, campaignSiteVisits.path],
      set: { visits: sql`${campaignSiteVisits.visits} + 1` },
    });
  return true;
}

/** Visits per campaign since `sinceDate` (YYYY-MM-DD, inclusive), or all time. */
export async function siteVisitCounts(opts: { sinceDate?: string; campaignIds?: string[] } = {}) {
  if (opts.campaignIds && opts.campaignIds.length === 0) return new Map<string, number>();
  const conds = [];
  if (opts.sinceDate) conds.push(gte(campaignSiteVisits.day, opts.sinceDate));
  if (opts.campaignIds) conds.push(inArray(campaignSiteVisits.campaignId, opts.campaignIds));
  const rows = await db
    .select({ campaignId: campaignSiteVisits.campaignId, n: sql<number>`sum(${campaignSiteVisits.visits})::int` })
    .from(campaignSiteVisits)
    .where(conds.length ? and(...conds) : undefined)
    .groupBy(campaignSiteVisits.campaignId);
  return new Map(rows.map((r) => [r.campaignId, Number(r.n)]));
}

/** Sign-ups per campaign whose account was created since `sinceDate` (YYYY-MM-DD, UTC). */
export async function signupCounts(sinceDate: string) {
  const rows = await db
    .select({ campaignId: users.signupCampaignId, n: sql<number>`count(*)::int` })
    .from(users)
    .where(and(isNotNull(users.signupCampaignId), gte(users.createdAt, new Date(`${sinceDate}T00:00:00Z`))))
    .groupBy(users.signupCampaignId);
  return new Map(rows.map((r) => [r.campaignId as string, Number(r.n)]));
}

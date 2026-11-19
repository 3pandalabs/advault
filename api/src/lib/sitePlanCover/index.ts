// "$55 a month" (owner decision 2026-11-19): the AdVault-made website stays on
// SiteVault Pro while the AdVault plan runs, instead of the $49/year renewal.
// The $10 website fee in month one is unchanged (lib/websiteFee).
//
// How: for every account with a live Keep it running plan, tell SiteVault to
// keep its AdVault-made site on Pro until the plan's paid period end
// (`setSitevaultPlanCover`). Runs from the plan-billing sweep (every 10 min,
// API only: it holds the SiteVault token) and remembers per process what it
// already pushed, so SiteVault hears about each new period once. A failure is
// retried by the next sweep. When the plan stops, nothing more is pushed and
// the site keeps what was covered, then follows SiteVault's own rules.
//
// Pure rule in ./policy.ts. Needs SiteVault's `plan-cover` route (follow-up in
// 3pandalabs/sitevault); until then every push answers 404 and is retried.

import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "../../db/index.js";
import { campaigns, subscriptions } from "../../db/schema.js";
import { setSitevaultPlanCover, sitevaultConfigured, slugFromSiteUrl } from "../sitevault/index.js";
import { PLAN_FOLLOWS_RUNNING_LINE } from "../planBilling/policy.js";
import { sitePlanCoverUntil } from "./policy.js";

const pushed = new Map<string, string>();

function log(msg: string, extra?: unknown): void {
  console.log(JSON.stringify({ job: "site-plan-cover", msg, extra: extra ?? undefined }));
}

/** The slug of the account's AdVault-made SiteVault site (we hold its edit key), or null. */
async function advaultMadeSiteSlug(userId: string): Promise<string | null> {
  const rows = await db
    .select({ landingUrl: campaigns.landingUrl })
    .from(campaigns)
    .where(and(eq(campaigns.userId, userId), isNotNull(campaigns.sitevaultEditEnc), isNotNull(campaigns.landingUrl)))
    .orderBy(desc(campaigns.createdAt))
    .limit(5);
  for (const r of rows) {
    const slug = slugFromSiteUrl(r.landingUrl);
    if (slug) return slug;
  }
  return null;
}

/** Keep this user's AdVault-made site on Pro to the end of their paid plan period. Never throws. */
export async function syncSitePlanCover(userId: string, now = new Date()): Promise<"pushed" | "unchanged" | "none" | "failed"> {
  try {
    if (!sitevaultConfigured()) return "none";
    const [sub] = await db
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.userId, userId),
          eq(subscriptions.line, PLAN_FOLLOWS_RUNNING_LINE),
          inArray(subscriptions.status, ["active", "past_due"]),
        ),
      )
      .orderBy(desc(subscriptions.createdAt))
      .limit(1);
    const until = sitePlanCoverUntil(sub ?? null, now);
    if (!until || !sub) return "none";
    const slug = await advaultMadeSiteSlug(userId);
    if (!slug) return "none";
    const key = `${slug}|${until.toISOString()}`;
    if (pushed.get(userId) === key) return "unchanged";
    const r = await setSitevaultPlanCover(slug, until, `plan:${sub.id}:${until.toISOString().slice(0, 10)}`);
    if (!r.ok) {
      log("plan cover push failed", { userId, slug, error: r.error });
      return "failed";
    }
    pushed.set(userId, key);
    return "pushed";
  } catch (err) {
    log("plan cover threw", { userId, error: String(err) });
    return "failed";
  }
}

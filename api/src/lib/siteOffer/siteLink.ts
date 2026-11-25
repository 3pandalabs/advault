// Is a campaign's link a website visitors can actually see? Only SiteVault
// links can be told apart: an unpublished or paused SiteVault site answers 200
// with a "This site isn't published yet" page, so the HTTP status isn't enough.

import { slugFromSiteUrl } from "../sitevault/index.js";
import { fetchSiteOfferStatus } from "./index.js";

/** "loading" = published but not answering yet. "unknown" = SiteVault couldn't say. */
export type SiteLinkState = "live" | "loading" | "unpublished" | "paused" | "not_found" | "unknown";

/** Never throws. A link that isn't a SiteVault site is always "live". */
export async function siteLinkState(url: string): Promise<SiteLinkState> {
  const slug = slugFromSiteUrl(url);
  if (!slug) return "live";
  const status = await fetchSiteOfferStatus(slug);
  if (status?.siteState === "unpublished" || status?.siteState === "paused") return status.siteState;
  const httpStatus = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(6_000) })
    .then(async (r) => {
      await r.body?.cancel().catch(() => {});
      return r.status;
    })
    .catch(() => null);
  if (!status) return httpStatus === 404 ? "not_found" : "unknown";
  return httpStatus !== null && httpStatus < 400 ? "live" : "loading";
}

/** Launch refuses a link we KNOW shows visitors nothing; an outage never blocks. */
export function siteLinkLaunchError(state: SiteLinkState): "website_not_published" | "website_paused" | "website_not_found" | null {
  if (state === "unpublished") return "website_not_published";
  if (state === "paused") return "website_paused";
  if (state === "not_found") return "website_not_found";
  return null;
}

/**
 * The link to burn into a video's end card or put in its YouTube description:
 * null when we KNOW it shows visitors nothing. A video can't be corrected
 * later, so a dead address is left off (launch refuses it anyway, and the ad's
 * button still carries the link once it works). An outage keeps the link.
 */
export async function showableLandingUrl(url: string | null): Promise<string | null> {
  if (!url) return null;
  return siteLinkLaunchError(await siteLinkState(url)) ? null : url;
}

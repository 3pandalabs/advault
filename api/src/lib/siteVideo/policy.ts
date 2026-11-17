// The ad video goes on the SiteVault website at launch (2026-11-16), not when
// the website is made: a website that already plays the ad removed the reason
// to launch. Pure rules, tested; index.ts does the I/O.

export const SITE_VIDEO_MAX_ATTEMPTS = 5;

/** SiteVault's internal video limit. */
export const SITE_VIDEO_MAX_BYTES = 40 * 1024 * 1024;

/**
 * Should launch ask for the video on the site? Default yes, only for a
 * SiteVault site AdVault made (it holds the edit link, `sitevault_edit_enc`).
 * SiteVault's video route refuses sites built on SiteVault itself
 * (`not_an_advault_site`), e.g. one linked through "Use my website".
 */
export function wantsSiteVideo(args: { requested: boolean | undefined; sitevaultSlug: string | null; advaultMade: boolean }): boolean {
  return Boolean(args.sitevaultSlug) && args.advaultMade && args.requested !== false;
}

/** Is a push still owed (wanted, not done, retries left)? */
export function siteVideoDue(c: { siteVideoWanted: boolean; siteVideoPushedAt: Date | null; siteVideoAttempts: number }): boolean {
  return c.siteVideoWanted && !c.siteVideoPushedAt && c.siteVideoAttempts < SITE_VIDEO_MAX_ATTEMPTS;
}

/**
 * Which finished ad goes on the site: the newest ready generated one,
 * widescreen first (it sits in a page column), else the vertical one. Customer
 * uploads are left out, as they always were for the website.
 */
export function pickSiteVideo<T extends { aspectRatio: string; videoKey: string | null; sizeBytes: number | null }>(
  newestFirst: T[],
): T | null {
  const fits = newestFirst.filter((r) => r.videoKey && (r.sizeBytes ?? 0) <= SITE_VIDEO_MAX_BYTES);
  return fits.find((r) => r.aspectRatio === "16:9") ?? fits[0] ?? null;
}

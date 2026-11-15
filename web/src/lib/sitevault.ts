// SiteVault links (3pandalabs/sitevault): customer sites live at
// <slug>.3pandasite.com. Mirrors api/src/lib/sitevault slugFromSiteUrl for the
// subdomain form.

export const SITEVAULT_SITES_DOMAIN = "3pandasite.com";

/** The SiteVault slug in a site link, or null when it isn't a SiteVault site. */
export function siteVaultSlug(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname;
    const suffix = `.${SITEVAULT_SITES_DOMAIN}`;
    return host.endsWith(suffix) ? host.slice(0, -suffix.length) || null : null;
  } catch {
    return null;
  }
}

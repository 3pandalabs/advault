import type { MetadataRoute } from "next";

// Public pages only: nothing behind sign-in, no one-time-link pages
// (/reset-password, /auth/handoff, /oauth/*) and not /report, which needs an ad
// id. No lastModified: there is no honest per-page date to give.
const SITE_URL = "https://advault.3pandalabs.com";

export default function sitemap(): MetadataRoute.Sitemap {
  return ["", "/signup", "/login", "/privacy", "/terms", "/content-policy", "/contact", "/faq"].map((path) => ({ url: `${SITE_URL}${path}` }));
}

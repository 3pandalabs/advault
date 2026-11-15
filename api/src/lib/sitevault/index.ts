// One-click website: AdVault asks SiteVault (3pandalabs/sitevault, a separate
// org product on Cloudflare Workers) to build a one-page site for a campaign
// whose business has no website, then uses it as the ad's link.
//
// Server to server: POST {SITEVAULT_URL}/api/internal/sites with bearer
// SITEVAULT_INTERNAL_TOKEN (same value as the Worker's INTERNAL_TOKEN secret).
// Same facts-only rules as the public SiteVault form: SiteVault refuses links
// in text, so the offer is cleaned of URLs before it is sent.

export const SITEVAULT_URL = (process.env.SITEVAULT_URL ?? "https://sitevault.3pandalabs.com").replace(/\/$/, "");

export function sitevaultConfigured(): boolean {
  return Boolean(process.env.SITEVAULT_INTERNAL_TOKEN);
}

/** AdVault's free-text category -> SiteVault's template key. */
export function sitevaultCategory(category: string): string {
  const c = category.toLowerCase();
  const rules: [RegExp, string][] = [
    [/plumb/, "plumbing"],
    [/electric/, "electrical"],
    [/hvac|heating|cooling|air ?con/, "hvac"],
    [/dent/, "dentist"],
    [/restaurant|cafe|café|food|pizza|diner/, "restaurant"],
    [/bak(ery|er)/, "bakery"],
    [/real[\s-]?estate|realt/, "realestate"],
    [/landscap|lawn|garden|tree/, "landscaping"],
    [/auto|car |mechanic|tyre|tire/, "auto"],
    [/clean|maid|janitor/, "cleaning"],
    [/barber/, "barber"],
    [/salon|hair|beauty|nail/, "salon"],
    [/spa|massage|wellness/, "spa"],
    [/clinic|medical|doctor|physio|chiro/, "clinic"],
    [/gym|fitness|yoga|pilates/, "fitness"],
    [/pet|groom|vet/, "petcare"],
    [/handyman|repair|roof|paint|contractor/, "handyman"],
  ];
  return rules.find(([re]) => re.test(c))?.[1] ?? "other";
}

/** First line of the offer, links removed, trimmed to SiteVault's 160-char banner. */
export function offerBanner(offerDetails: string | null | undefined): string {
  const line = (offerDetails ?? "")
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return "";
  const cleaned = line
    .replace(/(https?:\/\/\S+|www\.\S+|\b[a-z0-9-]+\.(com|net|org|io|co|info|biz|xyz|site|page|link|ly|me|app)\b\S*)/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return cleaned.length > 160 ? `${cleaned.slice(0, 157).trimEnd()}...` : cleaned;
}

export type WebsiteFields = {
  businessName: string;
  category: string;
  phone: string;
  city: string;
  offer?: string;
  serviceArea?: string;
  hours?: string;
  email?: string;
  services?: string;
  tagline?: string;
  /** The address the owner chose (<slug>.3pandasite.com); SiteVault picks one when absent. */
  slug?: string;
  /** "1": we charge the $10 website fee first; the site waits unpublished until markSitevaultPaid. */
  awaitingPayment?: string;
};

export type Photo = { bytes: Buffer; contentType: string };

export type SitevaultResult =
  | { ok: true; siteUrl: string; editUrl: string; slug: string }
  | { ok: false; status: number; errors: Record<string, string> };

/** The finished ad, shown on the site. MP4 only, under SiteVault's 40 MB limit. */
export type Video = { bytes: Buffer };

export async function createSitevaultSite(
  fields: WebsiteFields,
  photos: Photo[],
  video: Video | null = null,
): Promise<SitevaultResult> {
  const token = process.env.SITEVAULT_INTERNAL_TOKEN;
  if (!token) return { ok: false, status: 503, errors: { form: "website_builder_not_configured" } };
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v) form.append(k, v);
  photos.forEach((p, i) => {
    const ext = p.contentType === "image/png" ? "png" : p.contentType === "image/webp" ? "webp" : "jpg";
    form.append("photos", new Blob([new Uint8Array(p.bytes)], { type: p.contentType }), `photo-${i + 1}.${ext}`);
  });
  if (video) form.append("video", new Blob([new Uint8Array(video.bytes)], { type: "video/mp4" }), "ad.mp4");
  const res = await fetch(`${SITEVAULT_URL}/api/internal/sites`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    body: form,
    signal: AbortSignal.timeout(120_000),
  });
  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    siteUrl?: string;
    editUrl?: string;
    slug?: string;
    errors?: Record<string, string>;
    error?: string;
  };
  if (res.ok && body.ok && body.siteUrl && body.editUrl && body.slug) {
    return { ok: true, siteUrl: body.siteUrl, editUrl: body.editUrl, slug: body.slug };
  }
  return { ok: false, status: res.status, errors: body.errors ?? { form: body.error ?? `sitevault_${res.status}` } };
}

/** The $10 website fee landed: SiteVault publishes the site with a year of Pro. Idempotent on ref. */
export async function markSitevaultPaid(slug: string, ref: string): Promise<{ ok: true; siteUrl: string } | { ok: false; error: string }> {
  const token = process.env.SITEVAULT_INTERNAL_TOKEN;
  if (!token) return { ok: false, error: "sitevault_not_configured" };
  try {
    const res = await fetch(`${SITEVAULT_URL}/api/internal/sites/${encodeURIComponent(slug)}/paid`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ ref }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; siteUrl?: string; error?: string };
    if (res.ok && body.ok && body.siteUrl) return { ok: true, siteUrl: body.siteUrl };
    return { ok: false, error: `sitevault_${res.status}${body.error ? `:${body.error}` : ""}` };
  } catch (err) {
    return { ok: false, error: `sitevault_unreachable: ${String(err)}` };
  }
}

// ---------------------------------------------------------------------------
// Filling the site from the ad. The offer sticker is the ad's own summary of
// the advertiser's offer ("SPRING CLEANUP" / "$149" / "MOWING FROM $35
// WEEKLY"), written from their offer text under the no-invented-claims rule,
// so it is safe to reuse as the site's services list and tagline.

const KEEP_UPPER_STOP = new Set(["THE", "AND", "FOR", "OFF", "OUR", "ALL", "NEW", "ONE", "TWO", "YOU", "ANY", "PER", "NOW", "DAY", "GET", "TOP", "BIG"]);

/** "SPRING CLEANUP" -> "Spring cleanup"; short acronyms (EV, HVAC-ish 2-3 letters) stay. */
export function sentenceCase(text: string): string {
  const words = text.trim().split(/\s+/).map((w) => {
    const letters = w.replace(/[^A-Za-z]/g, "");
    const acronym = letters.length >= 2 && letters.length <= 3 && letters === letters.toUpperCase() && !KEEP_UPPER_STOP.has(letters);
    return acronym ? w : w.toLowerCase();
  });
  const joined = words.join(" ");
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}

export type StickerLike = { badge: string; headline: string; tagline: string; benefits: string[] };

const PRICEY = /[$%€£₹]|\d|\bfree\b/i;
const NOT_A_SERVICE = /\b(within|miles?|licensed|insured|zip|quotes?|same[- ]day|same week|guarantee)\b|\b\d{5}\b/i;

/** Services lines for SiteVault ("Name - price" or "Name"), from the ad's sticker. */
export function servicesFromSticker(sticker: StickerLike | null | undefined): string {
  if (!sticker) return "";
  const lines: string[] = [];
  if (sticker.headline) {
    lines.push(PRICEY.test(sticker.badge) ? `${sentenceCase(sticker.headline)} - ${sentenceCase(sticker.badge)}` : sentenceCase(sticker.headline));
  }
  for (const b of sticker.benefits ?? []) {
    if (PRICEY.test(b) && !NOT_A_SERVICE.test(b)) lines.push(sentenceCase(b));
  }
  return [...new Set(lines)].join("\n");
}

/** The sticker's tagline ("FREE QUOTES, SAME WEEK") as the site's one-liner. */
export function taglineFromSticker(sticker: StickerLike | null | undefined): string {
  return sticker?.tagline ? sentenceCase(sticker.tagline).slice(0, 120) : "";
}

// ---------------------------------------------------------------------------
// Addresses. A SiteVault site lives at <slug>.3pandasite.com and its owner can
// rename it on SiteVault's edit page (the old address then redirects). AdVault
// follows the rename so the ad's link never lands on a redirect.

export const SITEVAULT_SITES_DOMAIN = process.env.SITEVAULT_SITES_DOMAIN ?? "3pandasite.com";

/** The SiteVault slug in a site link, or null when the link isn't a SiteVault site. */
export function slugFromSiteUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const suffix = `.${SITEVAULT_SITES_DOMAIN}`;
    if (u.hostname.endsWith(suffix)) return u.hostname.slice(0, -suffix.length) || null;
    const m = u.pathname.match(/^\/s\/([a-z0-9-]+)\/?$/);
    if (`${u.protocol}//${u.host}` === SITEVAULT_URL && m) return m[1] ?? null;
  } catch {
    return null;
  }
  return null;
}

/** The site's current link (after any rename), or null if it can't be resolved. */
export async function resolveSitevaultSite(slug: string): Promise<string | null> {
  const token = process.env.SITEVAULT_INTERNAL_TOKEN;
  if (!token) return null;
  try {
    const res = await fetch(`${SITEVAULT_URL}/api/internal/resolve?slug=${encodeURIComponent(slug)}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { siteUrl?: string };
    return body.siteUrl ?? null;
  } catch {
    return null;
  }
}

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
    [/(car|auto|truck) ?wash|detailing|detailer/, "carwash"],
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
  /** The AdVault account that owns the site: SiteVault saves it to that owner's account (same login). */
  ownerAdvaultUserId?: string;
  ownerEmail?: string;
  /** "1": the owner is an AdVault admin making a test site. */
  ownerAdmin?: string;
  /** The Google place_id the owner picked ("Find my business on Google", lib/places). Optional. */
  placeId?: string;
};

export type Photo = { bytes: Buffer; contentType: string };

export type SitevaultResult =
  | { ok: true; siteUrl: string; editUrl: string; slug: string }
  | { ok: false; status: number; errors: Record<string, string>; code?: string; siteUrl?: string };

/** The finished ad, shown on the site. MP4 only, under SiteVault's 40 MB limit. */
export type Video = { bytes: Buffer };

/** One before & after pair of the advertiser's own work (lib/beforeAfter), as sent. */
export type BeforeAfterPhotos = { before: Photo; after: Photo };

function photoExt(contentType: string): string {
  return contentType === "image/png" ? "png" : contentType === "image/webp" ? "webp" : "jpg";
}

/**
 * Before & after pairs as SiteVault's internal create takes them: file fields
 * `ba1Before`, `ba1After`, `ba2Before`, `ba2After` (2026-11-17). Optional:
 * a site without pairs sends none of them, exactly as before. Both halves or
 * neither, at most two pairs; a half pair is dropped here rather than sent.
 */
export function appendBeforeAfter(form: FormData, pairs: readonly BeforeAfterPhotos[]): void {
  pairs
    .filter((p) => p.before && p.after)
    .slice(0, 2)
    .forEach((p, i) => {
      for (const [half, photo] of [["Before", p.before], ["After", p.after]] as const) {
        form.append(
          `ba${i + 1}${half}`,
          new Blob([new Uint8Array(photo.bytes)], { type: photo.contentType }),
          `ba${i + 1}-${half.toLowerCase()}.${photoExt(photo.contentType)}`,
        );
      }
    });
}

export async function createSitevaultSite(
  fields: WebsiteFields,
  photos: Photo[],
  video: Video | null = null,
  beforeAfter: readonly BeforeAfterPhotos[] = [],
): Promise<SitevaultResult> {
  const token = process.env.SITEVAULT_INTERNAL_TOKEN;
  if (!token) return { ok: false, status: 503, errors: { form: "website_builder_not_configured" } };
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v) form.append(k, v);
  photos.forEach((p, i) => {
    form.append("photos", new Blob([new Uint8Array(p.bytes)], { type: p.contentType }), `photo-${i + 1}.${photoExt(p.contentType)}`);
  });
  appendBeforeAfter(form, beforeAfter);
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
  return {
    ok: false,
    status: res.status,
    errors: body.errors ?? { form: body.error ?? `sitevault_${res.status}` },
    ...(body.error ? { code: body.error } : {}),
    // 409 account_has_site names the account's existing site.
    ...(typeof body.siteUrl === "string" ? { siteUrl: body.siteUrl } : {}),
  };
}

// ---------------------------------------------------------------------------
// "Make me a website" with SiteVault's FULL builder (2026-11-19). The
// pre-fill is too big for a URL (photos), and our photos are in our private
// R2, so it goes to SiteVault server to server as a "draft" (SiteVault
// web/src/drafts.ts); the iframe's signed create link names only the draft id.

export type DraftFields = Omit<WebsiteFields, "phone" | "city" | "slug"> & {
  campaignId: string;
  phone?: string;
  city?: string;
  ownerAdvaultUserId: string;
  /** Omitted for test customers (no real email): SiteVault links by id. */
  ownerEmail?: string;
};

/** Store the campaign's pre-fill on SiteVault. Never throws. */
export async function createSitevaultDraft(
  fields: DraftFields,
  photos: Photo[],
  video: Video | null = null,
  beforeAfter: readonly BeforeAfterPhotos[] = [],
): Promise<{ ok: true; draftId: string } | { ok: false; error: string }> {
  const token = process.env.SITEVAULT_INTERNAL_TOKEN;
  if (!token) return { ok: false, error: "sitevault_not_configured" };
  try {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) if (v) form.append(k, v);
    photos.forEach((p, i) => {
      form.append("photos", new Blob([new Uint8Array(p.bytes)], { type: p.contentType }), `photo-${i + 1}.${photoExt(p.contentType)}`);
    });
    appendBeforeAfter(form, beforeAfter);
    if (video) form.append("video", new Blob([new Uint8Array(video.bytes)], { type: "video/mp4" }), "ad.mp4");
    const res = await fetch(`${SITEVAULT_URL}/api/internal/drafts`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      body: form,
      signal: AbortSignal.timeout(120_000),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; draftId?: string; error?: string };
    if (res.ok && body.ok && typeof body.draftId === "string") return { ok: true, draftId: body.draftId };
    return { ok: false, error: body.error ?? `sitevault_${res.status}` };
  } catch (err) {
    return { ok: false, error: `sitevault_unreachable: ${String(err).slice(0, 200)}` };
  }
}

export type SitevaultDraft = {
  campaignId: string;
  awaitingPayment: boolean;
  /** What SiteVault made from the draft; null until the owner pressed Create. */
  result: { slug: string; siteUrl: string; editUrl: string; pending: boolean } | null;
};

/**
 * Read a draft back (after the frame said "created"). SiteVault answers 404
 * unless the draft is this AdVault user's, so a user can only ever confirm a
 * site made from their own draft. null = not theirs, unknown or unreachable.
 */
export async function fetchSitevaultDraft(draftId: string, advaultUserId: string): Promise<SitevaultDraft | null> {
  const token = process.env.SITEVAULT_INTERNAL_TOKEN;
  if (!token) return null;
  try {
    const q = new URLSearchParams({ advaultUserId });
    const res = await fetch(`${SITEVAULT_URL}/api/internal/drafts/${encodeURIComponent(draftId)}?${q}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const b = (await res.json().catch(() => null)) as { ok?: boolean; campaignId?: unknown; awaitingPayment?: unknown; result?: Record<string, unknown> | null } | null;
    if (!b?.ok || typeof b.campaignId !== "string") return null;
    const r = b.result;
    const result =
      r && typeof r.slug === "string" && typeof r.siteUrl === "string" && typeof r.editUrl === "string"
        ? { slug: r.slug, siteUrl: r.siteUrl, editUrl: r.editUrl, pending: r.pending === true }
        : null;
    return { campaignId: b.campaignId, awaitingPayment: b.awaitingPayment === true, result };
  } catch {
    return null;
  }
}

/** Put the ad video on the site (at launch). Replaces any earlier video. */
export async function setSitevaultVideo(slug: string, video: Video): Promise<{ ok: true } | { ok: false; error: string }> {
  const token = process.env.SITEVAULT_INTERNAL_TOKEN;
  if (!token) return { ok: false, error: "sitevault_not_configured" };
  try {
    const form = new FormData();
    form.append("video", new Blob([new Uint8Array(video.bytes)], { type: "video/mp4" }), "ad.mp4");
    const res = await fetch(`${SITEVAULT_URL}/api/internal/sites/${encodeURIComponent(slug)}/video`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      body: form,
      signal: AbortSignal.timeout(120_000),
    });
    if (res.ok) return { ok: true };
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: body.error ?? `sitevault_${res.status}` };
  } catch (err) {
    return { ok: false, error: String(err).slice(0, 200) };
  }
}

/** Make sure the site belongs to this AdVault user's SiteVault account (idempotent; never steals an owned site). */
export async function setSitevaultOwner(slug: string, owner: { advaultUserId: string; email: string }): Promise<boolean> {
  const token = process.env.SITEVAULT_INTERNAL_TOKEN;
  if (!token) return false;
  try {
    const res = await fetch(`${SITEVAULT_URL}/api/internal/sites/${encodeURIComponent(slug)}/owner`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(owner),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Delete the account's site for good (admin "Delete it and make a new one"):
 * SiteVault `DELETE /api/internal/sites/<slug>` removes its files, address,
 * phone and account link. Idempotent there (an unknown slug = deleted false).
 * Never throws. Errors: SiteVault's code (`not_your_site`, `has_subscription`)
 * or `sitevault_<status>` / `sitevault_unreachable`.
 */
export async function deleteSitevaultSite(
  slug: string,
  owner: { advaultUserId: string; email?: string | null },
): Promise<{ ok: true; slug: string; deleted: boolean } | { ok: false; error: string }> {
  const token = process.env.SITEVAULT_INTERNAL_TOKEN;
  if (!token) return { ok: false, error: "sitevault_not_configured" };
  try {
    const q = new URLSearchParams({ advaultUserId: owner.advaultUserId, ...(owner.email ? { email: owner.email } : {}) });
    const res = await fetch(`${SITEVAULT_URL}/api/internal/sites/${encodeURIComponent(slug)}?${q}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; slug?: string; deleted?: boolean; error?: string };
    if (res.ok && body.ok) return { ok: true, slug: body.slug ?? slug, deleted: Boolean(body.deleted) };
    return { ok: false, error: body.error ?? `sitevault_${res.status}` };
  } catch (err) {
    return { ok: false, error: `sitevault_unreachable: ${String(err).slice(0, 200)}` };
  }
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

/**
 * "$55 a month" (2026-11-19): the website is included while the AdVault plan
 * runs. Asks SiteVault to keep the AdVault-made site on Pro until `until`
 * (the plan's paid period end). SiteVault never shortens time already paid
 * for and treats a repeated `ref` as a no-op. NEEDS a SiteVault change
 * (`POST /api/internal/sites/<slug>/plan-cover`); until it is deployed this
 * answers sitevault_404 and the sweep simply retries.
 */
export async function setSitevaultPlanCover(
  slug: string,
  until: Date,
  ref: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const token = process.env.SITEVAULT_INTERNAL_TOKEN;
  if (!token) return { ok: false, error: "sitevault_not_configured" };
  try {
    const res = await fetch(`${SITEVAULT_URL}/api/internal/sites/${encodeURIComponent(slug)}/plan-cover`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ until: until.toISOString(), ref }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (res.ok && body.ok) return { ok: true };
    return { ok: false, error: `sitevault_${res.status}${body.error ? `:${body.error}` : ""}` };
  } catch (err) {
    return { ok: false, error: `sitevault_unreachable: ${String(err).slice(0, 200)}` };
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

export type AccountSitevaultSite = {
  slug: string;
  siteUrl: string;
  /** SiteVault's siteState: live | grace | unpublished | paused. */
  state: string;
  /** "web" = built on SiteVault, "advault" = made here. */
  source: string | null;
};

/** Is a SiteVault site state one an ad can link to? */
export function sitevaultStateIsLive(state: string | null | undefined): boolean {
  return state === "live" || state === "grace";
}

/**
 * The website the shared 3PandaLabs account owns on SiteVault, wherever it was
 * built (SiteVault `GET /api/internal/account-site`). null when there is none
 * OR when SiteVault can't say (down, not configured, or an older Worker
 * without the route): callers then behave as before this lookup existed, and
 * SiteVault's own create refuses a second site (409 `account_has_site`).
 */
export async function fetchAccountSitevaultSite(user: { advaultUserId: string; email?: string | null }): Promise<AccountSitevaultSite | null> {
  const token = process.env.SITEVAULT_INTERNAL_TOKEN;
  if (!token) return null;
  try {
    const q = new URLSearchParams({ advaultUserId: user.advaultUserId, ...(user.email ? { email: user.email } : {}) });
    const res = await fetch(`${SITEVAULT_URL}/api/internal/account-site?${q}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as Partial<AccountSitevaultSite> & { ok?: boolean } | null;
    if (!body?.ok || typeof body.slug !== "string" || typeof body.siteUrl !== "string") return null;
    return { slug: body.slug, siteUrl: body.siteUrl, state: String(body.state ?? ""), source: body.source ?? null };
  } catch {
    return null;
  }
}

/** Edit link for a SiteVault site AdVault holds no edit key for: SiteVault sends it through sign-in (same account). */
export function sitevaultSignInEditUrl(slug: string): string {
  return `${SITEVAULT_URL}/edit/${encodeURIComponent(slug)}`;
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

/**
 * The site's "Leave us a review" link (SiteVault `GET /api/internal/sites/<slug>/review-link`,
 * 2026-11-27): `{ reviewUrl: string | null }`. null = the owner set none;
 * undefined = SiteVault can't say (down, not configured, older Worker).
 * Only an https link is ever returned.
 */
export async function fetchSitevaultReviewLink(slug: string): Promise<string | null | undefined> {
  const token = process.env.SITEVAULT_INTERNAL_TOKEN;
  if (!token) return undefined;
  try {
    const res = await fetch(`${SITEVAULT_URL}/api/internal/sites/${encodeURIComponent(slug)}/review-link`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
    if (res.status === 404) return null;
    if (!res.ok) return undefined;
    const body = (await res.json().catch(() => null)) as { reviewUrl?: unknown; url?: unknown } | null;
    const url = body?.reviewUrl ?? body?.url ?? null;
    return typeof url === "string" && /^https:\/\//i.test(url) ? url : null;
  } catch {
    return undefined;
  }
}

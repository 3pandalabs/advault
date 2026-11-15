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
};

export type Photo = { bytes: Buffer; contentType: string };

export type SitevaultResult =
  | { ok: true; siteUrl: string; editUrl: string; slug: string }
  | { ok: false; status: number; errors: Record<string, string> };

export async function createSitevaultSite(fields: WebsiteFields, photos: Photo[]): Promise<SitevaultResult> {
  const token = process.env.SITEVAULT_INTERNAL_TOKEN;
  if (!token) return { ok: false, status: 503, errors: { form: "website_builder_not_configured" } };
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v) form.append(k, v);
  photos.forEach((p, i) => {
    const ext = p.contentType === "image/png" ? "png" : p.contentType === "image/webp" ? "webp" : "jpg";
    form.append("photos", new Blob([new Uint8Array(p.bytes)], { type: p.contentType }), `photo-${i + 1}.${ext}`);
  });
  const res = await fetch(`${SITEVAULT_URL}/api/internal/sites`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    body: form,
    signal: AbortSignal.timeout(60_000),
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

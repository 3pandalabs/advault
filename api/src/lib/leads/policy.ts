// Leads inbox: the pure rules (no db). Input shapes, which bookings hold a
// slot, the signed one-click Confirm / Decline links in the owner's email, and
// campaign attribution. Tested in policy.test.ts.
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { LeadKind, LeadSource, LeadStatus } from "../../db/schema.js";

export const LEAD_KINDS = ["quote", "callback", "booking"] as const satisfies readonly LeadKind[];
export const LEAD_STATUSES = ["new", "requested", "contacted", "confirmed", "declined", "done"] as const satisfies readonly LeadStatus[];

/** Not answered yet: the "N new leads" badge, and where Confirm / Decline still apply. */
export const UNANSWERED_STATUSES: LeadStatus[] = ["new", "requested"];

/**
 * A booking in one of these still holds its slot. The SiteVault contract says
 * requested + confirmed; new / contacted are included so a booking the owner
 * marked contacted (still undecided) keeps its time too.
 */
export const BUSY_STATUSES: LeadStatus[] = ["requested", "new", "contacted", "confirmed"];

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** "" and whitespace count as absent (SiteVault forms send empty strings). */
const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalText = (max: number) => z.preprocess(blankToUndefined, z.string().trim().max(max).optional());

export function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const bookingInput = z.object({
  service: z.string().trim().min(1).max(120),
  durationMin: z.number().int().min(5).max(12 * 60),
  start: z.string().datetime({ offset: true }),
  timezone: z.string().trim().min(1).max(64).refine(validTimezone, { message: "unknown time zone" }),
});

export const leadInput = z
  .object({
    slug: z.string().trim().toLowerCase().regex(SLUG_RE),
    kind: z.enum(LEAD_KINDS),
    name: z.string().trim().min(1).max(120),
    phone: z.string().trim().min(3).max(40),
    email: z.preprocess(blankToUndefined, z.string().trim().toLowerCase().email().max(254).optional()),
    message: optionalText(4000),
    bestTime: optionalText(120),
    photoUrls: z
      .array(z.string().url().max(1000).refine((u) => /^https:\/\//i.test(u), { message: "must be https" }))
      .max(10)
      .optional(),
    booking: bookingInput.optional(),
    source: z
      .object({
        referrerHost: optionalText(253),
        utmSource: optionalText(100),
        utmCampaign: optionalText(100),
      })
      .optional(),
    ownerEmail: z.preprocess(blankToUndefined, z.string().trim().toLowerCase().email().max(254).optional()),
    advaultUserId: z.preprocess(blankToUndefined, z.string().uuid().optional()),
    idempotencyKey: z.string().trim().min(1).max(200),
  })
  .superRefine((v, ctx) => {
    if (v.kind === "booking" && !v.booking) ctx.addIssue({ code: "custom", path: ["booking"], message: "required for a booking" });
  });

export type LeadInput = z.infer<typeof leadInput>;

/** The booking's [start, end) as Dates. */
export function bookingWindow(b: { start: string; durationMin: number }): { start: Date; end: Date } {
  const start = new Date(b.start);
  return { start, end: new Date(start.getTime() + b.durationMin * 60_000) };
}

/** Half-open intervals: back-to-back bookings (one ends 10:00, next starts 10:00) don't clash. */
export function overlaps(a: { start: Date; end: Date }, b: { start: Date; end: Date }): boolean {
  return a.start < b.end && b.start < a.end;
}

/** The source as stored: only the three known keys, only when set. */
export function cleanSource(s: LeadInput["source"]): LeadSource | null {
  if (!s) return null;
  const out: LeadSource = {};
  if (s.referrerHost) out.referrerHost = s.referrerHost.toLowerCase();
  if (s.utmSource) out.utmSource = s.utmSource;
  if (s.utmCampaign) out.utmCampaign = s.utmCampaign;
  return Object.keys(out).length ? out : null;
}

/**
 * The AdVault campaign a lead came from. Every AdVault launch tags the ad's
 * final URL with utm_campaign=<campaign id> (lib/googleAds/utm; utm_source is
 * "youtube", and "advault" is accepted too), so a uuid there is a candidate;
 * the caller only keeps it when that campaign belongs to the lead's owner.
 */
export function campaignIdFromSource(s: LeadSource | null): string | null {
  const id = s?.utmCampaign?.trim();
  return id && UUID_RE.test(id) ? id.toLowerCase() : null;
}

// ---------------------------------------------------------------------------
// One-click Confirm / Decline links in the owner's booking email. HMAC-SHA256
// over the lead id, the action and the expiry, keyed with JWT_SECRET under its
// own prefix (so no other token of this app can be replayed as one). Not
// single use on purpose: applying the same action twice is harmless (the
// status is already set), and the landing page asks for a tap before acting,
// so a mail scanner that prefetches the link changes nothing.

export type LinkAction = "confirm" | "decline";
const MAC_PREFIX = "3pl-lead-v1.";
export const LINK_TTL_SECONDS = 14 * 24 * 60 * 60;

function linkKey(): string | null {
  const k = process.env.JWT_SECRET;
  return k && k.length >= 16 ? k : null;
}

function mac(key: string, payload: string): string {
  return createHmac("sha256", key).update(MAC_PREFIX + payload).digest("base64url");
}

/** null when no key is configured (the email then has no one-click links). */
export function signLeadLink(leadId: string, action: LinkAction, nowMs = Date.now(), ttlSeconds = LINK_TTL_SECONDS): string | null {
  const key = linkKey();
  if (!key) return null;
  const payload = `${leadId}.${action === "confirm" ? "c" : "d"}.${Math.floor(nowMs / 1000) + ttlSeconds}`;
  return `${payload}.${mac(key, payload)}`;
}

export type VerifiedLink = { leadId: string; action: LinkAction };

export function verifyLeadLink(token: string, nowMs = Date.now()): VerifiedLink | null {
  const key = linkKey();
  if (!key || token.length > 300) return null;
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [leadId, a, exp, sig] = parts as [string, string, string, string];
  if (!UUID_RE.test(leadId) || (a !== "c" && a !== "d") || !/^\d{1,12}$/.test(exp)) return null;
  const want = Buffer.from(mac(key, `${leadId}.${a}.${exp}`));
  const got = Buffer.from(sig);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  if (Number(exp) * 1000 < nowMs) return null;
  return { leadId: leadId.toLowerCase(), action: a === "c" ? "confirm" : "decline" };
}

// ---------------------------------------------------------------------------
// Owner email throttle: a burst of form posts on one site must not eat the
// mailer's shared daily quota. Leads over the cap are still stored and shown.

const HOUR = 60 * 60_000;
export const OWNER_EMAILS_PER_SITE_PER_HOUR = 20;
const sent = new Map<string, number[]>();

export function allowOwnerEmail(slug: string, now: number): boolean {
  const list = (sent.get(slug) ?? []).filter((t) => t > now - HOUR);
  if (list.length >= OWNER_EMAILS_PER_SITE_PER_HOUR) {
    sent.set(slug, list);
    return false;
  }
  list.push(now);
  sent.set(slug, list);
  return true;
}

export function resetOwnerEmailLimits() {
  sent.clear();
}

/** A customer's SiteVault site address, for the decline email. */
export function siteUrlForSlug(slug: string): string {
  const domain = process.env.SITEVAULT_SITES_DOMAIN ?? "3pandasite.com";
  return `https://${slug}.${domain}`;
}

/** "Sat, Dec 6, 2:30 PM" in the booking's own time zone. */
export function formatBookingTime(at: Date, timezone: string | null): string {
  const tz = timezone && validTimezone(timezone) ? timezone : "UTC";
  const text = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(at);
  return tz === "UTC" && timezone !== "UTC" ? `${text} UTC` : text;
}

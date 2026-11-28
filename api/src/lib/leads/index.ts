// Leads inbox (2026-11-27, migration 0050). "Request a quote", "Call me back"
// and booking requests from a customer's SiteVault site arrive server to
// server (routes/sitevaultLeads.ts), are stored here, emailed to the owner, and
// shown on /dashboard/leads (routes/leads.ts). The database is passed in so
// everything runs against PGlite in tests. Rules without a db: policy.ts.
import { and, desc, eq, gte, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { campaigns, leads, purchases, users, type LeadKind, type LeadStatus } from "../../db/schema.js";
import { sendMail } from "../mailer.js";
import { notifyOps } from "../ops/notify.js";
import { webOrigin } from "../customerEmails/policy.js";
import { isUndeliverableEmail } from "../testMode/policy.js";
import { slugFromSiteUrl } from "../sitevault/index.js";
import type { Db } from "../sharedAccount/index.js";
import {
  BUSY_STATUSES,
  UNANSWERED_STATUSES,
  allowOwnerEmail,
  bookingWindow,
  campaignIdFromSource,
  cleanSource,
  signLeadLink,
  siteUrlForSlug,
  type LeadInput,
} from "./policy.js";
import { customerBookingMail, ownerLeadMail, reviewRequestMail, type LeadForEmail } from "./templates.js";

type Log = (msg: string) => void;
type LeadRow = typeof leads.$inferSelect;

/** Who is asking: an account id and/or an owner email (SiteVault passes either). */
export type OwnerRef = { userId?: string | null; email?: string | null };

const deliverable = (email: string | null | undefined): email is string => Boolean(email?.trim()) && !isUndeliverableEmail(email);

type Owner = { id: string; email: string; businessName: string | null; deletedAt: Date | null };

async function userById(db: Db, id: string): Promise<Owner | null> {
  const [u] = await db
    .select({ id: users.id, email: users.email, businessName: users.businessName, deletedAt: users.deletedAt })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  return u && !u.deletedAt ? u : null;
}

async function userByEmail(db: Db, email: string): Promise<Owner | null> {
  const [u] = await db
    .select({ id: users.id, email: users.email, businessName: users.businessName, deletedAt: users.deletedAt })
    .from(users)
    .where(eq(users.email, email.trim().toLowerCase()))
    .limit(1);
  return u && !u.deletedAt ? u : null;
}

/**
 * The account that owns a SiteVault site: the id SiteVault sent, else its
 * owner email, else the site link AdVault already keeps (a $10 website or
 * site-offer purchase for that slug, or a campaign whose link or unpaid site
 * is <slug>.3pandasite.com; newest first). null = nobody we know.
 */
export async function resolveLeadOwner(
  db: Db,
  ref: { slug: string; advaultUserId?: string; ownerEmail?: string },
): Promise<Owner | null> {
  if (ref.advaultUserId) {
    const u = await userById(db, ref.advaultUserId);
    if (u) return u;
  }
  if (ref.ownerEmail) {
    const u = await userByEmail(db, ref.ownerEmail);
    if (u) return u;
  }
  const [bought] = await db
    .select({ userId: purchases.userId })
    .from(purchases)
    .where(or(eq(purchases.websiteSlug, ref.slug), eq(purchases.siteOfferSlug, ref.slug)))
    .orderBy(desc(purchases.createdAt))
    .limit(1);
  if (bought?.userId) {
    const u = await userById(db, bought.userId);
    if (u) return u;
  }
  // The slug is [a-z0-9-] (policy SLUG_RE), so it is safe inside LIKE.
  const like = `%${ref.slug}%`;
  const linked = await db
    .select({ userId: campaigns.userId, landingUrl: campaigns.landingUrl, pending: campaigns.sitevaultPendingUrl })
    .from(campaigns)
    .where(or(sql`${campaigns.landingUrl} like ${like}`, sql`${campaigns.sitevaultPendingUrl} like ${like}`))
    .orderBy(desc(campaigns.createdAt))
    .limit(20);
  const hit = linked.find((c) => slugFromSiteUrl(c.landingUrl) === ref.slug || slugFromSiteUrl(c.pending) === ref.slug);
  return hit ? userById(db, hit.userId) : null;
}

export type CreateLeadResult =
  | { status: "created"; leadId: string }
  | { status: "existing"; leadId: string }
  | { status: "slot_taken" };

class SlotTaken extends Error {}

/**
 * Store one lead. Same (slug, idempotencyKey) = the same lead, never a second
 * row or email. A booking is checked for overlap with the site's bookings
 * still holding a slot, under a per-site advisory lock inside the
 * transaction, so two people can't both get 10:00. Then the owner is emailed
 * (never fails the store) and an unmatched owner pings ops.
 */
export async function createLead(db: Db, input: LeadInput, log: Log): Promise<CreateLeadResult> {
  const existing = await findByKey(db, input.slug, input.idempotencyKey);
  if (existing) return { status: "existing", leadId: existing };

  const owner = await resolveLeadOwner(db, { slug: input.slug, advaultUserId: input.advaultUserId, ownerEmail: input.ownerEmail });
  const source = cleanSource(input.source);
  let campaignId: string | null = null;
  const candidate = campaignIdFromSource(source);
  if (owner && candidate) {
    const [c] = await db
      .select({ id: campaigns.id })
      .from(campaigns)
      .where(and(eq(campaigns.id, candidate), eq(campaigns.userId, owner.id)))
      .limit(1);
    campaignId = c?.id ?? null;
  }
  const win = input.kind === "booking" && input.booking ? bookingWindow(input.booking) : null;

  let leadId: string;
  let created = false;
  try {
    leadId = await db.transaction(async (tx) => {
      if (win) {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"leads:" + input.slug}))`);
        // Re-check under the lock: the same request sent twice at once must
        // get its own lead back, not slot_taken against itself.
        const again = await findByKey(tx as unknown as Db, input.slug, input.idempotencyKey);
        if (again) return again;
        const [clash] = await tx
          .select({ id: leads.id })
          .from(leads)
          .where(
            and(
              eq(leads.siteSlug, input.slug),
              eq(leads.kind, "booking"),
              inArray(leads.status, BUSY_STATUSES),
              lt(leads.bookingStart, win.end),
              sql`${leads.bookingEnd} > ${win.start.toISOString()}::timestamptz`,
            ),
          )
          .limit(1);
        if (clash) throw new SlotTaken();
      }
      const [row] = await tx
        .insert(leads)
        .values({
          userId: owner?.id ?? null,
          ownerEmail: input.ownerEmail ?? null,
          siteSlug: input.slug,
          kind: input.kind,
          // The SiteVault contract: a booking starts "requested", the rest "new".
          status: input.kind === "booking" ? "requested" : "new",
          name: input.name,
          phone: input.phone,
          email: input.email ?? null,
          message: input.message ?? null,
          bestTime: input.bestTime ?? null,
          photoUrls: input.photoUrls ?? [],
          bookingService: win ? input.booking!.service : null,
          bookingDurationMin: win ? input.booking!.durationMin : null,
          bookingStart: win?.start ?? null,
          bookingEnd: win?.end ?? null,
          bookingTimezone: win ? input.booking!.timezone : null,
          source,
          campaignId,
          idempotencyKey: input.idempotencyKey,
        })
        .onConflictDoNothing({ target: [leads.siteSlug, leads.idempotencyKey] })
        .returning({ id: leads.id });
      if (row) {
        created = true;
        return row.id;
      }
      return (await findByKey(tx as unknown as Db, input.slug, input.idempotencyKey))!;
    });
  } catch (err) {
    if (err instanceof SlotTaken) return { status: "slot_taken" };
    throw err;
  }
  if (!created) return { status: "existing", leadId };

  if (!owner) {
    await notifyOps({
      title: "SiteVault lead with no AdVault owner",
      message: `A ${input.kind} lead (${leadId}) came from ${input.slug} and matched no account. It is stored; link the site's owner.`,
      tags: ["envelope"],
    });
  }
  await emailOwner(db, leadId, owner, log).catch((err) => log(`lead owner email failed: ${String(err)}`));
  return { status: "created", leadId };
}

async function findByKey(db: Db, slug: string, key: string): Promise<string | null> {
  const [r] = await db
    .select({ id: leads.id })
    .from(leads)
    .where(and(eq(leads.siteSlug, slug), eq(leads.idempotencyKey, key)))
    .limit(1);
  return r?.id ?? null;
}

function forEmail(l: LeadRow): LeadForEmail {
  return {
    id: l.id,
    kind: l.kind,
    name: l.name,
    phone: l.phone,
    email: l.email,
    message: l.message,
    bestTime: l.bestTime,
    photoUrls: l.photoUrls ?? [],
    bookingService: l.bookingService,
    bookingDurationMin: l.bookingDurationMin,
    bookingStart: l.bookingStart,
    bookingTimezone: l.bookingTimezone,
    fromAd: Boolean(l.campaignId),
  };
}

/** The owner's inbox address: the account's own, else what SiteVault sent. Never *.invalid. */
function ownerInbox(owner: Owner | null, lead: Pick<LeadRow, "ownerEmail">): string | null {
  if (owner && deliverable(owner.email)) return owner.email;
  if (!owner && deliverable(lead.ownerEmail)) return lead.ownerEmail;
  return null;
}

async function emailOwner(db: Db, leadId: string, owner: Owner | null, log: Log): Promise<void> {
  const [lead] = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
  if (!lead) return;
  const to = ownerInbox(owner, lead);
  if (!to) return log(`lead ${leadId}: no deliverable owner email`);
  if (!allowOwnerEmail(lead.siteSlug, Date.now())) return log(`lead ${leadId}: owner email throttled for ${lead.siteSlug}`);
  const base = webOrigin();
  const tokens =
    lead.kind === "booking" ? { c: signLeadLink(lead.id, "confirm"), d: signLeadLink(lead.id, "decline") } : { c: null, d: null };
  const res = await sendMail(
    [
      ownerLeadMail(to, forEmail(lead), {
        inbox: `${base}/dashboard/leads`,
        confirm: tokens.c ? `${base}/leads/action?t=${encodeURIComponent(tokens.c)}` : null,
        decline: tokens.d ? `${base}/leads/action?t=${encodeURIComponent(tokens.d)}` : null,
      }),
    ],
    log,
  );
  if (res.delivered > 0) await db.update(leads).set({ ownerEmailedAt: new Date() }).where(eq(leads.id, leadId));
}

/** Bookings that still hold a slot on [from, to). */
export async function busySlots(db: Db, slug: string, from: Date, to: Date): Promise<{ start: string; end: string }[]> {
  const rows = await db
    .select({ start: leads.bookingStart, end: leads.bookingEnd })
    .from(leads)
    .where(
      and(
        eq(leads.siteSlug, slug),
        eq(leads.kind, "booking"),
        inArray(leads.status, BUSY_STATUSES),
        lt(leads.bookingStart, to),
        sql`${leads.bookingEnd} > ${from.toISOString()}::timestamptz`,
      ),
    )
    .orderBy(leads.bookingStart)
    .limit(500);
  return rows.map((r) => ({ start: r.start!.toISOString(), end: r.end!.toISOString() }));
}

function ownerCondition(owner: OwnerRef): SQL | null {
  const parts: SQL[] = [];
  if (owner.userId) parts.push(eq(leads.userId, owner.userId));
  const email = owner.email?.trim().toLowerCase();
  if (email) {
    parts.push(sql`${leads.userId} in (select id from users where email = ${email} and deleted_at is null)`);
    parts.push(and(isNull(leads.userId), eq(leads.ownerEmail, email))!);
  }
  return parts.length ? or(...parts)! : null;
}

export type PublicLead = {
  id: string;
  kind: LeadKind;
  status: LeadStatus;
  siteSlug: string;
  name: string;
  phone: string;
  email: string | null;
  message: string | null;
  bestTime: string | null;
  photoUrls: string[];
  booking: { service: string; durationMin: number; start: string; end: string; timezone: string } | null;
  source: LeadRow["source"];
  campaignId: string | null;
  reviewRequestedAt: string | null;
  createdAt: string;
};

export function toPublicLead(l: LeadRow): PublicLead {
  return {
    id: l.id,
    kind: l.kind,
    status: l.status,
    siteSlug: l.siteSlug,
    name: l.name,
    phone: l.phone,
    email: l.email,
    message: l.message,
    bestTime: l.bestTime,
    photoUrls: l.photoUrls ?? [],
    booking:
      l.kind === "booking" && l.bookingStart && l.bookingEnd
        ? {
            service: l.bookingService ?? "",
            durationMin: l.bookingDurationMin ?? 0,
            start: l.bookingStart.toISOString(),
            end: l.bookingEnd.toISOString(),
            timezone: l.bookingTimezone ?? "UTC",
          }
        : null,
    source: l.source,
    campaignId: l.campaignId,
    reviewRequestedAt: l.reviewRequestedAt?.toISOString() ?? null,
    createdAt: l.createdAt.toISOString(),
  };
}

export async function listLeads(
  db: Db,
  owner: OwnerRef,
  filters: { slug?: string; kind?: LeadKind; status?: LeadStatus } = {},
): Promise<PublicLead[]> {
  const who = ownerCondition(owner);
  if (!who) return [];
  const rows = await db
    .select()
    .from(leads)
    .where(
      and(
        who,
        filters.slug ? eq(leads.siteSlug, filters.slug) : undefined,
        filters.kind ? eq(leads.kind, filters.kind) : undefined,
        filters.status ? eq(leads.status, filters.status) : undefined,
      ),
    )
    .orderBy(desc(leads.createdAt))
    .limit(500);
  return rows.map(toPublicLead);
}

export async function newLeadCount(db: Db, owner: OwnerRef): Promise<number> {
  const who = ownerCondition(owner);
  if (!who) return 0;
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(leads).where(and(who, inArray(leads.status, UNANSWERED_STATUSES)));
  return r?.n ?? 0;
}

/** The lead, only if it belongs to this owner. */
export async function loadOwnedLead(db: Db, id: string, owner: OwnerRef): Promise<LeadRow | null> {
  const who = ownerCondition(owner);
  if (!who) return null;
  const [l] = await db.select().from(leads).where(and(eq(leads.id, id), who)).limit(1);
  return l ?? null;
}

async function businessFor(db: Db, lead: LeadRow): Promise<{ name: string; ownerEmail: string | null; siteUrl: string }> {
  const owner = lead.userId ? await userById(db, lead.userId) : null;
  let name = owner?.businessName?.trim() || null;
  if (!name && lead.userId) {
    const [c] = await db
      .select({ name: campaigns.businessName })
      .from(campaigns)
      .where(eq(campaigns.userId, lead.userId))
      .orderBy(desc(campaigns.createdAt))
      .limit(1);
    name = c?.name ?? null;
  }
  return { name: name || "The business", ownerEmail: ownerInbox(owner, lead), siteUrl: siteUrlForSlug(lead.siteSlug) };
}

/**
 * Change a lead's status. A booking moved to confirmed / declined emails the
 * customer (when they left a real email), once per status it lands on.
 * Returns the updated row.
 */
export async function setLeadStatus(db: Db, lead: LeadRow, status: LeadStatus, log: Log): Promise<LeadRow> {
  const [row] = await db.update(leads).set({ status, updatedAt: new Date() }).where(eq(leads.id, lead.id)).returning();
  const updated = row ?? lead;
  if (
    updated.kind === "booking" &&
    (status === "confirmed" || status === "declined") &&
    updated.customerEmailedStatus !== status &&
    deliverable(updated.email)
  ) {
    const res = await sendMail(
      [customerBookingMail({ ...forEmail(updated), email: updated.email! }, status, await businessFor(db, updated))],
      log,
    ).catch((err) => {
      log(`lead ${lead.id}: customer booking email failed: ${String(err)}`);
      return null;
    });
    if (res && res.delivered > 0) {
      await db.update(leads).set({ customerEmailedStatus: status }).where(eq(leads.id, lead.id));
    }
  }
  return updated;
}

export type ReviewResult = "sent" | "already_sent" | "no_email" | "mailer_unavailable";

/** One friendly review ask per lead, ever. Claimed first, released if the mail didn't go. */
export async function requestReview(db: Db, lead: LeadRow, reviewUrl: string, log: Log): Promise<ReviewResult> {
  if (!deliverable(lead.email)) return "no_email";
  const [claimed] = await db
    .update(leads)
    .set({ reviewRequestedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(leads.id, lead.id), isNull(leads.reviewRequestedAt)))
    .returning({ id: leads.id });
  if (!claimed) return "already_sent";
  const biz = await businessFor(db, lead);
  const res = await sendMail([reviewRequestMail({ name: lead.name, email: lead.email! }, reviewUrl, biz)], log).catch((err) => {
    log(`lead ${lead.id}: review email failed: ${String(err)}`);
    return null;
  });
  if (!res || res.delivered === 0) {
    await db.update(leads).set({ reviewRequestedAt: null }).where(eq(leads.id, lead.id));
    return "mailer_unavailable";
  }
  return "sent";
}

export type LeadCounts = { quote: number; callback: number; booking: number; total: number };

/** "Leads from your website" for one campaign's results, since `since` (null = all time). */
export async function campaignLeadCounts(db: Db, campaignId: string, since: Date | null): Promise<LeadCounts> {
  const rows = await db
    .select({ kind: leads.kind, n: sql<number>`count(*)::int` })
    .from(leads)
    .where(and(eq(leads.campaignId, campaignId), since ? gte(leads.createdAt, since) : undefined))
    .groupBy(leads.kind);
  const out: LeadCounts = { quote: 0, callback: 0, booking: 0, total: 0 };
  for (const r of rows) {
    out[r.kind] = r.n;
    out.total += r.n;
  }
  return out;
}

/** Distinct site slugs this owner has leads for (for the review-link lookup). */
export async function ownerLeadSlugs(db: Db, owner: OwnerRef): Promise<string[]> {
  const who = ownerCondition(owner);
  if (!who) return [];
  const rows = await db.selectDistinct({ slug: leads.siteSlug }).from(leads).where(who).limit(10);
  return rows.map((r) => r.slug);
}

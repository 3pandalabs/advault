import { and, desc, eq, inArray, isNotNull, lte, or, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  campaigns,
  creatives,
  offerCycles,
  subscriptions,
  users,
  whatsappMessages,
} from "../../db/schema.js";
import { enqueueRender } from "../../render/jobs.js";
import { monthStart } from "../subscriptions/policy.js";
import {
  approvedMessage,
  classifyReply,
  inferOfferExpiry,
  previewMessage,
  SKIP_AFTER_DAYS,
  type CycleStatus,
} from "./policy.js";
import {
  whatsAppSendsEnabled,
  offerSwapMode,
  offerSwapWhatsAppEnabled,
  sendTemplate,
  sendText,
  TEMPLATES,
  whatsAppPublicNumber,
  whatsAppRecipientAllowed,
  type WhatsAppRecipient,
} from "../whatsapp/index.js";
import { hasOfferChanges, type ProductLine } from "../pricing/index.js";
import { liveSubscriptionFor } from "../subscriptions/index.js";
import { e164FromWhatsApp } from "../phone/index.js";

// The monthly offer loop, database side. The decisions live in ./policy.ts.
//
// What this module is actually for: making the recurring charge obvious to the
// customer. They are not buying a video subscription — nobody renews one of
// those — they are buying "this month's promotion goes out". That is a reason
// to exist every single month, and it is a conversation rather than a feature.

const DAY_LABEL = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** "Dec 3": the date the templates show. */
export function dayLabel(at: Date): string {
  return DAY_LABEL.format(at);
}

// ---------------------------------------------------------------------------
// Who may be messaged (2026-11-21). One rule for every WhatsApp send:
// WHATSAPP_SENDS=on, a phone, the owner's opt-in, and with
// OFFER_SWAP_WHATSAPP=internal an internal account (lib/whatsapp).
// ---------------------------------------------------------------------------

/** May this user be messaged on WhatsApp at all (any loop)? */
export function mayMessage(u: WhatsAppRecipient | null | undefined): boolean {
  return whatsAppRecipientAllowed(u, whatsAppSendsEnabled(), offerSwapMode());
}

/** Does the offer-CHANGE loop run for this user (inbound handled, news sent)? */
export function offerSwapAllowedFor(u: WhatsAppRecipient | null | undefined): boolean {
  return offerSwapWhatsAppEnabled() && mayMessage(u);
}

/**
 * What the web app shows about WhatsApp for this user. `available`: the
 * offer-change loop runs for accounts like theirs (sends on, mode, internal
 * rule, a plan with offer changes); `enabled`: available AND their number +
 * opt-in are saved. The public number is returned ONLY when enabled, so the
 * app never advertises a number that won't answer them.
 */
export async function whatsAppStateFor(u: WhatsAppRecipient & { id: string }) {
  const mode = offerSwapMode();
  let available = offerSwapWhatsAppEnabled() && (mode !== "internal" || u.isInternal);
  if (available) {
    const sub = await liveSubscriptionFor(u.id);
    available = Boolean(sub && hasOfferChanges(sub.line as ProductLine));
  }
  const optedIn = Boolean(u.whatsappOptInAt);
  const enabled = available && offerSwapAllowedFor(u);
  return {
    phone: u.phone,
    optedIn,
    available,
    enabled,
    ...(enabled ? { publicNumber: whatsAppPublicNumber().display, waLink: whatsAppPublicNumber().waLink } : {}),
  };
}

export async function whatsAppUser(userId: string) {
  const [row] = await db
    .select({
      id: users.id,
      phone: users.phone,
      whatsappOptInAt: users.whatsappOptInAt,
      isInternal: users.isInternal,
      deletedAt: users.deletedAt,
      businessName: users.businessName,
      displayName: users.displayName,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Message logging.
//
// Every message in or out is recorded, for two reasons: the inbound provider
// ref is the replay guard (Meta redelivers anything the webhook did not 200,
// and a redelivered "yes" must not approve a second month's ad), and an
// argument about what a customer approved is settled by the transcript.
// ---------------------------------------------------------------------------

export async function recordMessage(args: {
  userId?: string | null;
  offerCycleId?: string | null;
  direction: "inbound" | "outbound";
  phone: string;
  body: string;
  providerRef?: string | null;
  status?: string | null;
}): Promise<{ duplicate: boolean }> {
  try {
    await db.insert(whatsappMessages).values({
      userId: args.userId ?? null,
      offerCycleId: args.offerCycleId ?? null,
      direction: args.direction,
      phone: args.phone,
      body: args.body,
      providerRef: args.providerRef ?? null,
      status: args.status ?? null,
    });
    return { duplicate: false };
  } catch (err) {
    if ((err as { code?: string }).code === "23505") return { duplicate: true };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Cycles.
// ---------------------------------------------------------------------------

/**
 * Opens this month's cycle for a subscriber, if it isn't already open.
 *
 * Idempotent on (user_id, period_month) — which is what makes the scheduler
 * safe to run hourly. Without that index a retry sends a second WhatsApp
 * message to a real person, and there is no undo for that.
 */
export async function ensureCycleForMonth(args: {
  userId: string;
  subscriptionId: string | null;
  at?: Date;
}) {
  const periodMonth = monthStart(args.at ?? new Date());
  try {
    const [created] = await db
      .insert(offerCycles)
      .values({
        userId: args.userId,
        subscriptionId: args.subscriptionId,
        periodMonth,
        status: "pending",
      })
      .returning();
    return created;
  } catch (err) {
    if ((err as { code?: string }).code !== "23505") throw err;
    const [existing] = await db
      .select()
      .from(offerCycles)
      .where(and(eq(offerCycles.userId, args.userId), eq(offerCycles.periodMonth, periodMonth)))
      .limit(1);
    return existing;
  }
}

/** Opens a cycle for every subscriber currently entitled to service. */
export async function openCyclesForEntitledSubscribers(at = new Date()) {
  const subs = await db
    .select({ id: subscriptions.id, userId: subscriptions.userId })
    .from(subscriptions)
    .where(
      and(
        inArray(subscriptions.status, ["active", "past_due"]),
        // Evergreen ("Keep it running") never gets the ORIGINAL loop (its
        // expiry pauses the campaign). Since 2026-11-21 it gets the monthly
        // "What's this month's offer?" prompt for the offer-CHANGE loop
        // (lib/offerSwap/whatsapp.ts), only when that loop is switched on
        // and only with a launched campaign to change.
        offerSwapWhatsAppEnabled()
          ? or(
              inArray(subscriptions.line, ["offer", "managed"]),
              and(
                eq(subscriptions.line, "evergreen"),
                sql`exists (select 1 from campaigns c where c.user_id = ${subscriptions.userId} and c.status in ('live','paused') and c.google_ad_group_resource_name is not null)`,
                // OFFER_SWAP_WHATSAPP=internal: only 3PandaLabs' own accounts.
                offerSwapMode() === "internal"
                  ? sql`exists (select 1 from users u where u.id = ${subscriptions.userId} and u.is_internal)`
                  : sql`true`,
              ),
            )
          : inArray(subscriptions.line, ["offer", "managed"]),
      ),
    );

  let opened = 0;
  for (const sub of subs) {
    const cycle = await ensureCycleForMonth({
      userId: sub.userId,
      subscriptionId: sub.id,
      at,
    });
    if (cycle?.status === "pending") opened += 1;
  }
  return opened;
}

export async function cyclesNeedingAttention(limit = 200) {
  return db
    .select()
    .from(offerCycles)
    .where(inArray(offerCycles.status, ["pending", "prompted"]))
    .orderBy(offerCycles.periodMonth)
    .limit(limit);
}

/**
 * The user's contact for a send. `phone` is null unless they may be messaged
 * (mayMessage: sends on, opted in, internal-only in `internal` mode), so
 * every send in this module is gated by the one rule.
 */
async function contactFor(userId: string) {
  const row = await whatsAppUser(userId);
  if (!row) return null;
  return { ...row, phone: mayMessage(row) ? row.phone : null };
}

/** Since when the owner's current ad has been running (the prompt's {{3}}). */
async function runningSince(userId: string, fallback: Date): Promise<Date> {
  const [c] = await db
    .select({ launchedAt: campaigns.launchedAt })
    .from(campaigns)
    .where(and(eq(campaigns.userId, userId), inArray(campaigns.status, ["live", "paused"]), isNotNull(campaigns.launchedAt)))
    .orderBy(desc(campaigns.launchedAt))
    .limit(1);
  return c?.launchedAt ?? fallback;
}

/**
 * Sends the opening prompt for a cycle.
 *
 * A TEMPLATE, necessarily: this message opens the conversation, so it falls
 * outside any 24-hour service window and Meta will only deliver a pre-approved
 * template. See lib/whatsapp for why that distinction is forced at the call
 * site rather than hidden behind a flag.
 */
export async function sendPrompt(cycleId: string, now = new Date()) {
  const [cycle] = await db.select().from(offerCycles).where(eq(offerCycles.id, cycleId)).limit(1);
  if (!cycle) return { sent: false, reason: "no_such_cycle" as const };

  const contact = await contactFor(cycle.userId);
  if (!contact?.phone) return { sent: false, reason: "no_phone" as const };
  if (!whatsAppSendsEnabled()) return { sent: false, reason: "not_configured" as const };

  const business = contact.businessName ?? contact.displayName ?? "your business";
  // advault_offer_prompt: {{1}} name, {{2}} business, {{3}} running-since date.
  const params = [contact.displayName ?? "there", business, dayLabel(await runningSince(cycle.userId, cycle.periodMonth))];

  const result = await sendTemplate({
    to: contact.phone,
    template: TEMPLATES.monthlyOfferPrompt,
    params,
  });

  await recordMessage({
    userId: cycle.userId,
    offerCycleId: cycle.id,
    direction: "outbound",
    phone: contact.phone,
    body: `[template ${TEMPLATES.monthlyOfferPrompt}] ${params.join(" | ")}`,
    providerRef: result.providerRef,
  });

  await db
    .update(offerCycles)
    .set({ status: "prompted", promptedAt: now, updatedAt: now })
    .where(eq(offerCycles.id, cycle.id));

  return { sent: true as const };
}

export async function sendReminder(cycleId: string, reminderNumber: number, now = new Date()) {
  const [cycle] = await db.select().from(offerCycles).where(eq(offerCycles.id, cycleId)).limit(1);
  if (!cycle) return { sent: false, reason: "no_such_cycle" as const };

  const contact = await contactFor(cycle.userId);
  if (!contact?.phone) return { sent: false, reason: "no_phone" as const };
  if (!whatsAppSendsEnabled()) return { sent: false, reason: "not_configured" as const };

  const business = contact.businessName ?? contact.displayName ?? "your business";
  // advault_offer_reminder: {{1}} name, {{2}} business, {{3}} reply-by date
  // (the day the cycle is skipped, SKIP_AFTER_DAYS after the prompt).
  const replyBy = new Date((cycle.promptedAt ?? now).getTime() + SKIP_AFTER_DAYS * 86_400_000);
  const params = [contact.displayName ?? "there", business, dayLabel(replyBy)];

  const result = await sendTemplate({
    to: contact.phone,
    template: TEMPLATES.offerReminder,
    params,
  });

  await recordMessage({
    userId: cycle.userId,
    offerCycleId: cycle.id,
    direction: "outbound",
    phone: contact.phone,
    body: `[template ${TEMPLATES.offerReminder}] ${params.join(" | ")}`,
    providerRef: result.providerRef,
  });

  await db
    .update(offerCycles)
    .set({ reminderCount: reminderNumber, updatedAt: now })
    .where(eq(offerCycles.id, cycle.id));

  return { sent: true as const };
}

/**
 * Gives up on a cycle for this month.
 *
 * Deliberately leaves any previous offer running rather than pausing it. A shop
 * that didn't reply still wants its ad up; silence is not a cancellation.
 */
export async function skipCycle(cycleId: string, now = new Date()) {
  await db
    .update(offerCycles)
    .set({ status: "skipped", updatedAt: now })
    .where(eq(offerCycles.id, cycleId));
}

// ---------------------------------------------------------------------------
// Inbound replies — the state machine.
// ---------------------------------------------------------------------------

/**
 * Matches a WhatsApp sender (E.164 digits, no plus) to accounts.
 *
 * EXACT match on the E.164 phone (2026-11-21, migration 0048; the old
 * last-10-digits match collided between countries, e.g. US and India). A
 * legacy row typed without a "+" still matches when its digits are the
 * sender's full number. Deleted accounts never match. More than one match
 * is reported, never guessed: attributing one shop's offer to another
 * shop's campaign is the worst outcome available here.
 */
export async function matchPhone(from: string): Promise<
  | { kind: "none" }
  | { kind: "many"; count: number }
  | { kind: "one"; user: { id: string; phone: string | null; whatsappOptInAt: Date | null; isInternal: boolean; deletedAt: Date | null } }
> {
  const e164 = e164FromWhatsApp(from);
  if (!e164) return { kind: "none" };
  const digits = e164.slice(1);
  const rows = await db
    .select({ id: users.id, phone: users.phone, whatsappOptInAt: users.whatsappOptInAt, isInternal: users.isInternal, deletedAt: users.deletedAt })
    .from(users)
    .where(
      and(
        sql`${users.deletedAt} is null`,
        or(
          eq(users.phone, e164),
          // '[^0-9]', not a backslash-D: inside a JS template literal that
          // cooks to a bare "D" (fixed 2026-11-21). `digits` is a parameter.
          sql`(${users.phone} not like '+%' and regexp_replace(${users.phone}, '[^0-9]', '', 'g') = ${digits})`,
        ),
      ),
    )
    .limit(5);
  if (rows.length === 0) return { kind: "none" };
  if (rows.length > 1) return { kind: "many", count: rows.length };
  return { kind: "one", user: rows[0]! };
}

/** The one account for a WhatsApp sender, or null (none or ambiguous). */
export async function userForPhone(phone: string) {
  const m = await matchPhone(phone);
  return m.kind === "one" ? m.user : null;
}

export const UNKNOWN_SENDER_REPLY =
  "We couldn't find an AdVault account with this number. Add it in Settings at https://advault.3pandalabs.com/dashboard/settings.";
export const AMBIGUOUS_SENDER_REPLY =
  "This number is on more than one AdVault account, so we can't tell which ad to change. Please change your offer on your campaign page at https://advault.3pandalabs.com/dashboard.";
const UNMATCHED_REPLY_EVERY_MS = 24 * 3_600_000;

/**
 * A sender we can't place (no account, or several). Records the message
 * (unattributed) and, while the offer-change loop is running, answers ONCE
 * per number per 24 h. Free text is allowed: their message just opened the
 * 24-hour window. No reply when the loop is off.
 */
export async function replyToUnmatchedSender(args: {
  from: string;
  body: string;
  providerRef: string;
  kind: "none" | "many";
  now?: Date;
  log?: (m: string, e?: unknown) => void;
}): Promise<{ replied: boolean; duplicate: boolean }> {
  const now = args.now ?? new Date();
  const logged = await recordMessage({ direction: "inbound", phone: args.from, body: args.body, providerRef: args.providerRef });
  if (logged.duplicate) return { replied: false, duplicate: true };
  if (args.kind === "many") args.log?.("WhatsApp sender matches several accounts", { from: args.from });
  if (!offerSwapWhatsAppEnabled()) return { replied: false, duplicate: false };

  const e164 = e164FromWhatsApp(args.from);
  const [recent] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(whatsappMessages)
    .where(
      and(
        eq(whatsappMessages.direction, "outbound"),
        sql`${whatsappMessages.userId} is null`,
        inArray(whatsappMessages.phone, e164 ? [args.from, e164] : [args.from]),
        sql`${whatsappMessages.createdAt} > ${new Date(now.getTime() - UNMATCHED_REPLY_EVERY_MS).toISOString()}`,
      ),
    );
  if ((recent?.n ?? 0) > 0) return { replied: false, duplicate: false };

  const body = args.kind === "many" ? AMBIGUOUS_SENDER_REPLY : UNKNOWN_SENDER_REPLY;
  try {
    const r = await sendText({ to: args.from, body });
    await recordMessage({ direction: "outbound", phone: args.from, body, providerRef: r.providerRef });
    return { replied: true, duplicate: false };
  } catch (err) {
    args.log?.("unmatched-sender WhatsApp reply failed", err);
    return { replied: false, duplicate: false };
  }
}

export type ReplyOutcome =
  | { handled: false; reason: "unknown_sender" | "not_allowed" | "no_open_cycle" | "duplicate" | "unclear" }
  | { handled: true; action: "offer_recorded" | "approved" | "rejected"; cycleId: string };

/**
 * Applies an inbound WhatsApp reply to the sender's open cycle.
 *
 * The whole loop in one function because the steps are not independently
 * useful: classify against the cycle's CURRENT state, record, and advance. The
 * state matters — "yes" before we have an offer is an acknowledgement with no
 * content, and "yes" after a preview is permission to publish someone's
 * advertising.
 */
export async function applyInboundReply(args: {
  phone: string;
  body: string;
  providerRef: string;
  now?: Date;
}): Promise<ReplyOutcome> {
  const now = args.now ?? new Date();

  const user = await userForPhone(args.phone);
  if (!user) {
    // Still recorded, unattributed — an inbound message we cannot place is
    // worth seeing rather than dropping.
    await recordMessage({
      direction: "inbound",
      phone: args.phone,
      body: args.body,
      providerRef: args.providerRef,
    });
    return { handled: false, reason: "unknown_sender" };
  }
  // Not opted in (or not internal while OFFER_SWAP_WHATSAPP=internal):
  // recorded against them, nothing acted on and nothing sent.
  if (!mayMessage(user)) {
    const logged = await recordMessage({ userId: user.id, direction: "inbound", phone: args.phone, body: args.body, providerRef: args.providerRef });
    return { handled: false, reason: logged.duplicate ? "duplicate" : "not_allowed" };
  }

  const [cycle] = await db
    .select()
    .from(offerCycles)
    .where(
      and(
        eq(offerCycles.userId, user.id),
        inArray(offerCycles.status, ["pending", "prompted", "answered", "previewed"]),
      ),
    )
    .orderBy(desc(offerCycles.periodMonth))
    .limit(1);

  const logged = await recordMessage({
    userId: user.id,
    offerCycleId: cycle?.id ?? null,
    direction: "inbound",
    phone: args.phone,
    body: args.body,
    providerRef: args.providerRef,
  });
  // Meta redelivers anything we did not 200. The provider ref index is what
  // stops the redelivery being processed a second time.
  if (logged.duplicate) return { handled: false, reason: "duplicate" };

  if (!cycle) return { handled: false, reason: "no_open_cycle" };

  const intent = classifyReply(args.body, cycle.status as CycleStatus);

  switch (intent.intent) {
    case "unclear":
      return { handled: false, reason: "unclear" };

    case "reject":
      await skipCycle(cycle.id, now);
      return { handled: true, action: "rejected", cycleId: cycle.id };

    case "approve":
      await approveCycle(cycle.id, now);
      return { handled: true, action: "approved", cycleId: cycle.id };

    case "offer": {
      await recordOffer({ cycleId: cycle.id, text: intent.text, now });
      return { handled: true, action: "offer_recorded", cycleId: cycle.id };
    }
  }
}

/**
 * Stores this month's offer and starts producing the creative.
 *
 * Also sets the campaign's expiry. An offer campaign that outlives its deadline
 * is worse than no campaign — it spends budget driving people to a deal the
 * shop will not honour — and nothing at Google expires it for us.
 */
export async function recordOffer(args: { cycleId: string; text: string; now?: Date }) {
  const now = args.now ?? new Date();
  const expiry = inferOfferExpiry(args.text, now);

  const [cycle] = await db
    .update(offerCycles)
    .set({
      status: "answered",
      offerText: args.text,
      offerExpiresAt: expiry.expiresAt,
      answeredAt: now,
      updatedAt: now,
    })
    .where(eq(offerCycles.id, args.cycleId))
    .returning();

  // Carry the offer onto the campaign, if this subscriber has one. The offer
  // line has none — it sells creatives and no media — which is exactly why the
  // Q1 product can ship before any Google dependency exists.
  const [campaign] = await db
    .select({ id: campaigns.id })
    .from(campaigns)
    .where(and(eq(campaigns.userId, cycle.userId), inArray(campaigns.status, ["ready", "live", "paused"])))
    .orderBy(desc(campaigns.createdAt))
    .limit(1);

  if (campaign) {
    await db
      .update(campaigns)
      .set({
        offerDetails: args.text,
        offerExpiresAt: expiry.expiresAt,
        offerExpiredAt: null,
        updatedAt: now,
      })
      .where(eq(campaigns.id, campaign.id));

    await db
      .update(offerCycles)
      .set({ campaignId: campaign.id, updatedAt: now })
      .where(eq(offerCycles.id, cycle.id));

    // Re-render every creative against the new offer. The renderer picks these
    // up through the same FOR UPDATE SKIP LOCKED queue as a first render.
    const rows = await db
      .select({ id: creatives.id })
      .from(creatives)
      .where(eq(creatives.campaignId, campaign.id));
    for (const c of rows) await enqueueRender(c.id);
  }

  return { cycle, expiry };
}

/** Sends the preview and asks for a yes. Free text — we are inside the window. */
export async function sendPreview(cycleId: string, now = new Date()) {
  const [cycle] = await db.select().from(offerCycles).where(eq(offerCycles.id, cycleId)).limit(1);
  if (!cycle || !cycle.offerText || !cycle.offerExpiresAt) {
    return { sent: false, reason: "not_ready" as const };
  }

  const contact = await contactFor(cycle.userId);
  if (!contact?.phone || !whatsAppSendsEnabled()) {
    return { sent: false, reason: "not_configured" as const };
  }

  const guessed = !inferOfferExpiry(cycle.offerText, cycle.answeredAt ?? now).parsed;
  const body = previewMessage(cycle.offerText, cycle.offerExpiresAt, guessed);
  const result = await sendText({ to: contact.phone, body });

  await recordMessage({
    userId: cycle.userId,
    offerCycleId: cycle.id,
    direction: "outbound",
    phone: contact.phone,
    body,
    providerRef: result.providerRef,
  });

  await db
    .update(offerCycles)
    .set({ status: "previewed", previewedAt: now, updatedAt: now })
    .where(eq(offerCycles.id, cycle.id));

  return { sent: true as const };
}

export async function approveCycle(cycleId: string, now = new Date()) {
  const [cycle] = await db
    .update(offerCycles)
    .set({ status: "approved", approvedAt: now, updatedAt: now })
    .where(eq(offerCycles.id, cycleId))
    .returning();

  const contact = await contactFor(cycle.userId);
  if (contact?.phone && cycle.offerExpiresAt && whatsAppSendsEnabled()) {
    const body = approvedMessage(cycle.offerExpiresAt);
    const result = await sendText({ to: contact.phone, body });
    await recordMessage({
      userId: cycle.userId,
      offerCycleId: cycle.id,
      direction: "outbound",
      phone: contact.phone,
      body,
      providerRef: result.providerRef,
    });
  }

  return cycle;
}

// ---------------------------------------------------------------------------
// Offer expiry.
// ---------------------------------------------------------------------------

/**
 * Campaigns whose offer deadline has passed and which are still live.
 *
 * The pause itself belongs to the caller, because pausing at Google needs
 * credentials the API container does not want to hold on a sweep — see
 * render/offerCycles.ts.
 */
export async function campaignsPastOfferExpiry(now = new Date(), limit = 100) {
  return db
    .select({
      id: campaigns.id,
      userId: campaigns.userId,
      googleCampaignResourceName: campaigns.googleCampaignResourceName,
      googleCustomerId: campaigns.googleCustomerId,
      offerExpiresAt: campaigns.offerExpiresAt,
    })
    .from(campaigns)
    .where(
      and(
        eq(campaigns.status, "live"),
        lte(campaigns.offerExpiresAt, now),
        sql`${campaigns.offerExpiredAt} is null`,
      ),
    )
    .limit(limit);
}

export async function markOfferExpired(campaignId: string, now = new Date()) {
  await db
    .update(campaigns)
    .set({ status: "paused", offerExpiredAt: now, updatedAt: now })
    .where(eq(campaigns.id, campaignId));
}

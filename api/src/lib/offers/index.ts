import { and, desc, eq, inArray, lte, sql } from "drizzle-orm";
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
  promptMessage,
  reminderMessage,
  type CycleStatus,
} from "./policy.js";
import {
  isWhatsAppConfigured,
  sendTemplate,
  sendText,
  TEMPLATES,
} from "../whatsapp/index.js";

// The monthly offer loop, database side. The decisions live in ./policy.ts.
//
// What this module is actually for: making the recurring charge obvious to the
// customer. They are not buying a video subscription — nobody renews one of
// those — they are buying "this month's promotion goes out". That is a reason
// to exist every single month, and it is a conversation rather than a feature.

const MONTH_LABEL = new Intl.DateTimeFormat("en", { month: "long", timeZone: "UTC" });

function monthLabel(at: Date): string {
  return MONTH_LABEL.format(at);
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
    .where(inArray(subscriptions.status, ["active", "past_due"]));

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

async function contactFor(userId: string) {
  const [row] = await db
    .select({
      phone: users.phone,
      businessName: users.businessName,
      displayName: users.displayName,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row ?? null;
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
  if (!isWhatsAppConfigured()) return { sent: false, reason: "not_configured" as const };

  const business = contact.businessName ?? contact.displayName ?? "your business";
  const label = monthLabel(cycle.periodMonth);

  const result = await sendTemplate({
    to: contact.phone,
    template: TEMPLATES.monthlyOfferPrompt,
    params: [business, label],
  });

  await recordMessage({
    userId: cycle.userId,
    offerCycleId: cycle.id,
    direction: "outbound",
    phone: contact.phone,
    body: promptMessage(business, label),
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
  if (!isWhatsAppConfigured()) return { sent: false, reason: "not_configured" as const };

  const business = contact.businessName ?? contact.displayName ?? "your business";
  const label = monthLabel(cycle.periodMonth);

  const result = await sendTemplate({
    to: contact.phone,
    template: TEMPLATES.offerReminder,
    params: [business, label],
  });

  await recordMessage({
    userId: cycle.userId,
    offerCycleId: cycle.id,
    direction: "outbound",
    phone: contact.phone,
    body: reminderMessage(business, label),
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
 * Matches an inbound phone number to a user.
 *
 * Compares the last 10 digits, because WhatsApp reports E.164 without a plus
 * and users store their number in whatever shape they typed it. Ten digits is
 * enough to be unique within a country and short enough to survive the country
 * code being present on one side only. An ambiguous match returns null rather
 * than guessing — attributing one shop's offer to another shop's campaign is
 * the worst outcome available here.
 */
export async function userForPhone(phone: string) {
  const digits = phone.replace(/\D/g, "");
  const tail = digits.slice(-10);
  if (tail.length < 10) return null;

  const rows = await db
    .select({ id: users.id, phone: users.phone })
    .from(users)
    // `tail` is digits-only by construction above, and is still bound as a
    // parameter rather than interpolated.
    .where(sql`right(regexp_replace(coalesce(${users.phone}, ''), '\D', '', 'g'), 10) = ${tail}`);

  return rows.length === 1 ? rows[0] : null;
}

export type ReplyOutcome =
  | { handled: false; reason: "unknown_sender" | "no_open_cycle" | "duplicate" | "unclear" }
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
  if (!contact?.phone || !isWhatsAppConfigured()) {
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
  if (contact?.phone && cycle.offerExpiresAt && isWhatsAppConfigured()) {
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

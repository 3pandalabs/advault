// The monthly offer conversation, as pure functions.
//
// Everything here runs against a string a shop owner typed on their phone and a
// clock. No database, no HTTP — so all of it is testable, which matters more
// here than anywhere else in the codebase: this module decides what a real
// person's WhatsApp reply means, and getting that wrong either publishes an
// advertisement they did not approve or silently ignores one they did.

export type CycleStatus =
  | "pending"
  | "prompted"
  | "answered"
  | "previewed"
  | "approved"
  | "skipped";

// ---------------------------------------------------------------------------
// Reply classification.
// ---------------------------------------------------------------------------

/**
 * Affirmatives, including the Hinglish ones.
 *
 * "haan", "ha", "theek hai" and "ji" are how a large share of Indian small
 * business owners actually reply, and an English-only list would read those as
 * an offer description and render an ad whose script is the word "haan". The
 * emoji are here for the same reason — a thumbs-up is a common, unambiguous
 * yes on WhatsApp and would otherwise fall through to the offer branch.
 */
const AFFIRMATIVE = new Set([
  "y",
  "ok",
  "okay",
  "yes",
  "yep",
  "yeah",
  "sure",
  "approve",
  "approved",
  "go",
  "send",
  "publish",
  "confirm",
  "haan",
  "han",
  "ha",
  "ji",
  "theek",
  "theek hai",
  "thik hai",
  "sahi",
  "done",
  "👍",
  "👍🏽",
  "✅",
]);

const NEGATIVE = new Set([
  "n",
  "no",
  "nope",
  "stop",
  "cancel",
  "wait",
  "not now",
  "nahi",
  "nahin",
  "na",
  "❌",
]);

export type ReplyIntent =
  | { intent: "approve" }
  | { intent: "reject" }
  | { intent: "offer"; text: string }
  | { intent: "unclear" };

/**
 * What did this reply mean, given where the conversation is?
 *
 * Context-dependent on purpose. The same word means different things at
 * different points: "yes" while we are waiting to hear the offer is an
 * acknowledgement with no content, and treating it as the offer would render an
 * ad that says "yes". "yes" after a preview is an approval to publish.
 */
export function classifyReply(body: string, status: CycleStatus): ReplyIntent {
  const trimmed = body.trim();
  if (!trimmed) return { intent: "unclear" };

  const normalised = trimmed.toLowerCase().replace(/[.!,]+$/g, "");

  if (NEGATIVE.has(normalised)) return { intent: "reject" };

  const isAffirmative = AFFIRMATIVE.has(normalised);

  if (status === "previewed") {
    if (isAffirmative) return { intent: "approve" };
    // Anything else after a preview is a revision, not an approval. Treating an
    // unrecognised reply as a yes would publish an ad on the strength of a
    // message we could not read.
    return { intent: "offer", text: trimmed };
  }

  // Waiting to hear the offer. A bare affirmative carries no content.
  if (isAffirmative) return { intent: "unclear" };
  // Two characters is not an offer. Requiring some substance keeps a stray
  // "hi" from becoming ad copy.
  if (trimmed.length < 3) return { intent: "unclear" };

  return { intent: "offer", text: trimmed };
}

// ---------------------------------------------------------------------------
// Offer expiry.
// ---------------------------------------------------------------------------

const WEEKDAYS: Record<string, number> = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  tues: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  thurs: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
};

const MONTHS: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8,
  september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};

/** End of the day, so "till Sunday" includes all of Sunday. */
function endOfDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59));
}

/** Last instant of the month containing `now` — the fallback deadline. */
export function endOfMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59));
}

/**
 * Best-effort deadline for an offer, from the text the owner typed.
 *
 * ALWAYS returns a date. That is the important property, not the parsing:
 * "30% off till Sunday" still serving in December is worse than no ad at all —
 * it burns budget and sends people to a shop that will turn them away — and
 * nothing at Google expires it on our behalf. So an unparseable offer expires
 * at the end of the month rather than never, and `parsed` tells the caller
 * whether to trust the date or to confirm it with the owner.
 */
export function inferOfferExpiry(
  text: string,
  now: Date,
): { expiresAt: Date; parsed: boolean } {
  const t = text.toLowerCase();

  // "till 15th", "until 20", "before 3rd"
  const dayMatch = t.match(/\b(?:till|until|upto|up to|before|by)\s+(\d{1,2})(?:st|nd|rd|th)?\b/);
  if (dayMatch) {
    const day = Number(dayMatch[1]);
    if (day >= 1 && day <= 31) {
      const thisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), day));
      // A day already past means they mean next month.
      const target =
        thisMonth.getTime() >= now.getTime()
          ? thisMonth
          : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, day));
      return { expiresAt: endOfDay(target), parsed: true };
    }
  }

  // "till 20 Aug", "until 3 September"
  const dateMonth = t.match(
    /\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b/,
  );
  if (dateMonth) {
    const day = Number(dateMonth[1]);
    const month = MONTHS[dateMonth[2]];
    if (month !== undefined && day >= 1 && day <= 31) {
      let year = now.getUTCFullYear();
      const candidate = new Date(Date.UTC(year, month, day));
      // A month already behind us means next year, not eleven months ago.
      if (candidate.getTime() < now.getTime() - 86_400_000 * 3) year += 1;
      return { expiresAt: endOfDay(new Date(Date.UTC(year, month, day))), parsed: true };
    }
  }

  // "till sunday", "this weekend"
  const weekdayMatch = t.match(
    /\b(?:till|until|upto|up to|before|by|this|on)\s+(sun|mon|tue|tues|wed|thu|thurs|fri|sat)[a-z]*\b/,
  );
  if (weekdayMatch) {
    const target = WEEKDAYS[weekdayMatch[1]];
    if (target !== undefined) {
      const delta = (target - now.getUTCDay() + 7) % 7;
      const d = new Date(now.getTime() + delta * 86_400_000);
      return { expiresAt: endOfDay(d), parsed: true };
    }
  }

  if (/\bweekend\b/.test(t)) {
    const delta = (0 - now.getUTCDay() + 7) % 7; // through Sunday
    return { expiresAt: endOfDay(new Date(now.getTime() + delta * 86_400_000)), parsed: true };
  }

  // No deadline stated. End of month, and flagged as a guess.
  return { expiresAt: endOfMonth(now), parsed: false };
}

// ---------------------------------------------------------------------------
// Prompt cadence.
//
// The constraint that shapes all of this: WhatsApp is a channel you can lose.
// A shop owner who feels nagged reports the number, and enough reports cost the
// business account itself — not one customer, the channel. So reminders are
// few, widely spaced, and stop entirely rather than escalating.
// ---------------------------------------------------------------------------

export const MAX_REMINDERS = 2;
const REMINDER_AFTER_DAYS = [3, 7];
const SKIP_AFTER_DAYS = 12;

export type CycleAction =
  | { action: "prompt" }
  | { action: "remind"; reminderNumber: number }
  | { action: "skip" }
  | { action: "wait" };

export function nextCycleAction(args: {
  status: CycleStatus;
  promptedAt: Date | null;
  reminderCount: number;
  now: Date;
}): CycleAction {
  if (args.status === "pending") return { action: "prompt" };

  // Anything past "prompted" means the owner is engaged; the reminder ladder
  // is only for silence.
  if (args.status !== "prompted") return { action: "wait" };
  if (!args.promptedAt) return { action: "wait" };

  const daysSince = (args.now.getTime() - args.promptedAt.getTime()) / 86_400_000;

  if (daysSince >= SKIP_AFTER_DAYS) return { action: "skip" };

  if (args.reminderCount < MAX_REMINDERS) {
    const due = REMINDER_AFTER_DAYS[args.reminderCount];
    if (daysSince >= due) return { action: "remind", reminderNumber: args.reminderCount + 1 };
  }

  return { action: "wait" };
}

// ---------------------------------------------------------------------------
// Message copy.
//
// Kept here rather than in the provider so it is covered by the same tests, and
// so changing what we say to customers does not mean touching the code that
// talks to Meta.
// ---------------------------------------------------------------------------

export function promptMessage(businessName: string, monthLabel: string): string {
  return (
    `${monthLabel} offer for ${businessName}?\n\n` +
    `Reply with the deal — e.g. "30% off colouring till 15th" — and we'll have the ad ready today.`
  );
}

export function reminderMessage(businessName: string, monthLabel: string): string {
  return (
    `Still happy to put together ${businessName}'s ${monthLabel} ad. ` +
    `Just reply with this month's offer whenever you're ready.`
  );
}

export function previewMessage(offerText: string, expiresAt: Date, guessed: boolean): string {
  const date = expiresAt.toISOString().slice(0, 10);
  const deadline = guessed
    ? `We've set it to run until ${date} — reply with a date to change that.`
    : `Running until ${date}.`;
  return `Here's your ad for: "${offerText}".\n\n${deadline}\n\nReply YES to put it live.`;
}

export function approvedMessage(expiresAt: Date): string {
  return `Live. It'll stop automatically on ${expiresAt.toISOString().slice(0, 10)}.`;
}

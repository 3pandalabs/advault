// Google's spend for a day grows while the ad runs (and can shrink when Google
// filters invalid clicks), but the hourly sync used to record ONE ledger row per
// campaign-day, keyed `gads:<campaign>:<date>`, and skip every later reading as
// a duplicate. The wallet kept only the first partial figure of each day
// (2026-11-25: ~$28 spent, ~$8 debited). Now each run records the DIFFERENCE
// between Google's figure and what the ledger already holds for that day.
//
// Keys: the first row of a day keeps the old key (so rows written before this
// change still count); each later correction is `<base>:<n>`, n = rows so far.
// Two runs that race compute the same key, so the unique index lets one win.

export const SPEND_REF_PREFIX = "gads:";

export function spendBaseRef(campaignId: string, date: string): string {
  return `${SPEND_REF_PREFIX}${campaignId}:${date}`;
}

/** The date of a spend row's key, or null when the key isn't one of this campaign's. */
export function spendRefDate(ref: string | null | undefined, campaignId: string): string | null {
  const head = `${SPEND_REF_PREFIX}${campaignId}:`;
  if (!ref?.startsWith(head)) return null;
  const m = ref.slice(head.length).match(/^(\d{4}-\d{2}-\d{2})(?::\d+)?$/);
  return m ? m[1]! : null;
}

/** What one campaign-day already holds in the ledger: debits are negative. */
export type DayLedger = { sumMinor: number; rows: number };

/** Groups a campaign's ledger rows by spend day. */
export function ledgerByDay(
  rows: { externalRef: string | null; amountMinor: number }[],
  campaignId: string,
): Map<string, DayLedger> {
  const out = new Map<string, DayLedger>();
  for (const r of rows) {
    const date = spendRefDate(r.externalRef, campaignId);
    if (!date) continue;
    const d = out.get(date) ?? { sumMinor: 0, rows: 0 };
    out.set(date, { sumMinor: d.sumMinor + r.amountMinor, rows: d.rows + 1 });
  }
  return out;
}

/**
 * The ledger row that brings a day in line with Google's figure, or null when
 * it already matches. Negative = more spend to debit; positive = Google lowered
 * the day (invalid clicks), credited back as an adjustment.
 */
export function spendCorrection(args: {
  campaignId: string;
  date: string;
  reportedMinor: number;
  ledger: DayLedger | undefined;
}): { amountMinor: number; externalRef: string; type: "spend" | "adjustment" } | null {
  const held = args.ledger ?? { sumMinor: 0, rows: 0 };
  const amountMinor = -Math.max(args.reportedMinor, 0) - held.sumMinor;
  if (amountMinor === 0) return null;
  const base = spendBaseRef(args.campaignId, args.date);
  return {
    amountMinor,
    externalRef: held.rows === 0 ? base : `${base}:${held.rows}`,
    type: amountMinor < 0 ? "spend" : "adjustment",
  };
}

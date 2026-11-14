import { z } from "zod";

// Real-estate campaigns come in two kinds (2026-11-13):
//   listing — one home for sale, usually with an open house: the ad names the
//             street, the price, beds/baths and the open-house day and time.
//   agent   — the agent themselves ("thinking of selling?"), no listing.
// Stored on campaigns.realty (migration 0016) and fed to the script writer
// (script/prompt.ts). Everything here is what the advertiser typed, so it may
// appear in the ad: it is their claim, not ours.

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM");

export const realtySchema = z
  .object({
    adType: z.enum(["listing", "agent"]),
    price: z.string().trim().max(20).nullish(),
    beds: z.number().min(0).max(20).nullish(),
    baths: z.number().min(0).max(20).multipleOf(0.5).nullish(),
    openHouse: z
      .object({ date: isoDate, start: hhmm, end: hhmm })
      .strict()
      .refine((o) => o.end > o.start, { message: "end must be after start" })
      .nullish(),
  })
  .strict();

export type Realty = z.infer<typeof realtySchema>;

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function clock(hhmm: string): { h: number; m: number; ampm: "AM" | "PM" } {
  const [H, M] = hhmm.split(":").map(Number);
  return { h: H % 12 === 0 ? 12 : H % 12, m: M, ampm: H < 12 ? "AM" : "PM" };
}
function clockText(hhmm: string, withAmPm = true): string {
  const c = clock(hhmm);
  return `${c.h}${c.m ? `:${String(c.m).padStart(2, "0")}` : ""}${withAmPm ? ` ${c.ampm}` : ""}`;
}

/** "Sunday, November 16, 1–4 PM" (or "11 AM–2 PM" across noon). */
export function openHouseLong(o: { date: string; start: string; end: string }): string {
  const d = new Date(`${o.date}T12:00:00Z`);
  const same = clock(o.start).ampm === clock(o.end).ampm;
  return `${DAYS[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${clockText(o.start, !same)}–${clockText(o.end)}`;
}

/** "OPEN HOUSE SUN 1–4" for the sticker (26 chars max). */
export function openHouseTag(o: { date: string; start: string; end: string }): string {
  const d = new Date(`${o.date}T12:00:00Z`);
  return `OPEN HOUSE ${DAYS[d.getUTCDay()].slice(0, 3).toUpperCase()} ${clockText(o.start, false)}–${clockText(o.end, false)}`;
}

/** "$489,000" -> "$489K", "$1,250,000" -> "$1.25M"; otherwise as typed. */
export function shortPrice(price: string): string {
  const n = Number(price.replace(/[$,\s]/g, ""));
  if (!Number.isFinite(n) || n <= 0) return price.trim().slice(0, 10);
  if (n >= 1_000_000) return `$${Number((n / 1_000_000).toFixed(2))}M`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}K`;
  return `$${n}`;
}

/** "3 BED · 2 BATH" (half baths as 2.5). */
export function bedsBaths(r: Pick<Realty, "beds" | "baths">): string | null {
  const parts = [r.beds != null ? `${r.beds} BED` : null, r.baths != null ? `${r.baths} BATH` : null].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

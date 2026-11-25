// Seasonal calendar (2026-11-20): per category, the peak seasons, each with a
// suggested offer and call to action. The campaign page shows a card when the
// next season is near ("Fall is coming. Switch to your leaf removal ad?"); the
// owner sees the offer in an editable box and saves it with
// PUT /campaigns/:id/offer. Nothing here ever changes a live ad: the saved
// offer is used by the NEXT ad made. Pure, tested (seasons.test.ts).
//
// The offers are starting points with example prices, like the wizard's
// examples: the card tells the owner to change them so every word is true.
//
// Mirrored for the browser in web/src/lib/categories/seasons.ts (the block
// between the <shared> markers, word for word, mirror.test.ts).

import type { CategoryKey, Market } from "./key.js";

// <shared>
/** Month 1-12, day 1-31. */
export type MonthDay = readonly [number, number];

export type Season = {
  id: string;
  /** "Fall leaf removal": names the ad in the card. */
  name: string;
  /** "Fall": the card says "Fall is coming" / "Fall is here". */
  when: string;
  /** Every year from..to (may wrap the new year), or every month on these days. */
  from?: MonthDay;
  to?: MonthDay;
  monthly?: { fromDay: number; toDay: number };
  offer: string;
  callToAction: string;
  /** Only in these markets (absent = every market). */
  markets?: readonly Market[];
  /** Real estate: only for agent ads (a listing ad is one home's facts). */
  agentAdsOnly?: boolean;
};

/** How many days before a season starts the card appears. */
export const SEASON_LEAD_DAYS = 21;
/** Month-end seasons come round every month, so they show closer to the day. */
export const MONTHLY_LEAD_DAYS = 5;

export const SEASONS: Record<CategoryKey, readonly Season[]> = {
  landscaping: [
    {
      id: "spring-cleanup",
      name: "spring cleanup",
      when: "Spring",
      from: [3, 1],
      to: [5, 15],
      offer: "Spring cleanup from $149. Beds edged, leaves and branches cleared. Free quotes, same week.",
      callToAction: "Book a cleanup",
    },
    {
      id: "summer-mowing",
      name: "weekly mowing",
      when: "Summer",
      from: [5, 16],
      to: [8, 31],
      offer: "Weekly mowing from $35 a visit. Same crew every week, clippings cleared. Free quotes.",
      callToAction: "Get a free quote",
    },
    {
      id: "fall-leaves",
      name: "leaf removal and aeration",
      when: "Fall",
      from: [9, 1],
      to: [11, 30],
      offer: "Fall leaf removal and aeration from $129. Get your lawn ready for spring. Free quotes.",
      callToAction: "Book a cleanup",
    },
    {
      id: "winter-snow",
      name: "snow removal",
      when: "Winter",
      from: [12, 1],
      to: [2, 28],
      offer: "Snow removal for driveways and walks. Seasonal plans available. Get on our route today.",
      callToAction: "Get a free quote",
      markets: ["US"],
    },
  ],
  hvac: [
    {
      id: "spring-ac",
      name: "AC tune-up",
      when: "Summer",
      from: [3, 15],
      to: [6, 15],
      offer: "AC tune-up $79. Beat the summer rush. Licensed technicians, upfront pricing.",
      callToAction: "Book a tune-up",
    },
    {
      id: "fall-furnace",
      name: "furnace check",
      when: "Fall",
      from: [9, 1],
      to: [11, 15],
      offer: "Furnace safety check $89. Be ready before the first cold night.",
      callToAction: "Book a check",
      markets: ["US"],
    },
  ],
  plumbing: [
    {
      id: "spring-sump",
      name: "sump pump check",
      when: "Spring",
      from: [3, 1],
      to: [4, 30],
      offer: "Sump pump check $79 before the spring rains. Same-day service.",
      callToAction: "Book a plumber",
      markets: ["US"],
    },
    {
      id: "winter-pipes",
      name: "frozen pipe",
      when: "Winter",
      from: [11, 15],
      to: [2, 15],
      offer: "Frozen or burst pipe? We come out fast. Ask about pipe insulation before the next freeze.",
      callToAction: "Book a plumber",
      markets: ["US"],
    },
  ],
  electrical: [
    {
      id: "storm-generator",
      name: "generator install",
      when: "Storm season",
      from: [5, 1],
      to: [7, 31],
      offer: "Home generator installs before storm season. Free estimates. Licensed and insured.",
      callToAction: "Get a free estimate",
      markets: ["US"],
    },
    {
      id: "holiday-lighting",
      name: "holiday lighting",
      when: "The holiday season",
      from: [10, 15],
      to: [12, 10],
      offer: "Holiday lighting and outdoor outlets, installed safely. Free estimates.",
      callToAction: "Get a free estimate",
    },
  ],
  dentistry: [
    {
      id: "back-to-school",
      name: "back-to-school checkup",
      when: "Back to school",
      from: [7, 15],
      to: [8, 31],
      offer: "Back-to-school checkups for kids. Evening and Saturday appointments.",
      callToAction: "Book an appointment",
    },
    {
      id: "use-benefits",
      name: "use-your-benefits",
      when: "Year end",
      from: [10, 1],
      to: [12, 31],
      offer: "Use your dental benefits before Dec 31. Book your cleaning and checkup now.",
      callToAction: "Book your cleaning",
      markets: ["US"],
    },
  ],
  auto: [
    {
      id: "spring-tires",
      name: "spring tire changeover",
      when: "Spring",
      from: [3, 15],
      to: [4, 30],
      offer: "Spring tire changeover $59. Swap back and get a free brake check.",
      callToAction: "Book a service",
      markets: ["US"],
    },
    {
      id: "summer-ac",
      name: "AC recharge",
      when: "Summer",
      from: [5, 15],
      to: [7, 31],
      offer: "Car AC recharge $99. Stay cool before the heat hits. Most cars done same day.",
      callToAction: "Book a service",
    },
    {
      id: "winter-tires",
      name: "winter tire changeover",
      when: "Winter",
      from: [10, 15],
      to: [12, 15],
      offer: "Winter tire changeover $59. Get in before the first snow.",
      callToAction: "Book a service",
      markets: ["US"],
    },
  ],
  carWash: [
    {
      id: "salt-wash",
      name: "winter salt wash",
      when: "Winter",
      from: [12, 1],
      to: [2, 28],
      offer: "Get the road salt off. Full wash with undercarriage rinse $19.",
      callToAction: "Visit us today",
      markets: ["US"],
    },
    {
      id: "spring-detail",
      name: "spring detail",
      when: "Spring",
      from: [3, 1],
      to: [5, 15],
      offer: "Spring detail $20 off. Inside vacuumed and shampooed, outside washed and waxed.",
      callToAction: "Book a detail",
    },
    {
      id: "summer-wash",
      name: "summer wash",
      when: "Summer",
      from: [5, 16],
      to: [8, 31],
      offer: "Summer wash deal: $5 off any full-service wash. Bugs, dust and pollen gone.",
      callToAction: "Visit us today",
    },
    {
      id: "holiday-gift-cards",
      name: "car wash gift cards",
      when: "The holiday season",
      from: [11, 15],
      to: [12, 24],
      offer: "Car wash gift cards. An easy gift for every driver on your list.",
      callToAction: "Buy a gift card",
    },
  ],
  cleaning: [
    {
      id: "spring-clean",
      name: "spring deep clean",
      when: "Spring",
      from: [3, 1],
      to: [4, 30],
      offer: "Spring deep clean 20% off. Every room, top to bottom. Insured cleaners.",
      callToAction: "Book a clean",
    },
    {
      id: "lease-season",
      name: "move-out and move-in clean",
      when: "Lease season",
      from: [5, 15],
      to: [8, 31],
      offer: "Move-out and move-in cleaning. Help get your deposit back. Booking now for month end.",
      callToAction: "Book a clean",
      markets: ["US"],
    },
    {
      id: "holiday-clean",
      name: "holiday deep clean",
      when: "The holiday season",
      from: [11, 10],
      to: [12, 20],
      offer: "Holiday deep clean before your guests arrive. Book early, spots fill fast.",
      callToAction: "Book a clean",
    },
    {
      id: "month-end-move",
      name: "month-end move-out clean",
      when: "Month end",
      monthly: { fromDay: 22, toDay: 31 },
      offer: "Moving out at month end? Move-out cleaning, done before you hand back the keys.",
      callToAction: "Book a clean",
    },
  ],
  restaurant: [
    {
      id: "valentines",
      name: "Valentine's dinner",
      when: "Valentine's Day",
      from: [1, 25],
      to: [2, 14],
      offer: "Valentine's dinner for two. Reserve your table now.",
      callToAction: "Reserve a table",
    },
    {
      id: "mothers-day",
      name: "Mother's Day brunch",
      when: "Mother's Day",
      from: [4, 25],
      to: [5, 14],
      offer: "Mother's Day brunch. Treat her. Reserve your table today.",
      callToAction: "Reserve a table",
    },
    {
      id: "game-day",
      name: "game day platters",
      when: "Game season",
      from: [9, 1],
      to: [2, 10],
      offer: "Game day wings and platters. Order ahead for kickoff.",
      callToAction: "Order now",
      markets: ["US"],
    },
    {
      id: "holiday-catering",
      name: "holiday catering",
      when: "The holiday season",
      from: [11, 15],
      to: [12, 24],
      offer: "Holiday party catering. Trays for 10 to 100 people. Order ahead.",
      callToAction: "Order now",
    },
  ],
  realEstate: [
    {
      id: "spring-market",
      name: "spring selling",
      when: "Spring",
      from: [2, 15],
      to: [5, 31],
      offer: "Thinking of selling this spring? Free home valuation. Call me today.",
      callToAction: "Get a free home valuation",
      agentAdsOnly: true,
    },
    {
      id: "fall-market",
      name: "sell before the holidays",
      when: "Fall",
      from: [9, 1],
      to: [10, 31],
      offer: "Sell before the holidays. Free home valuation and a plan to list this fall.",
      callToAction: "Get a free home valuation",
      agentAdsOnly: true,
    },
  ],
};

const DAY_MS = 86_400_000;

function utcDay(y: number, m: number, d: number): number {
  // Day 31 in a 30-day month (or Feb 30) rolls back to the month's last day.
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Date.UTC(y, m - 1, Math.min(d, last));
}

/** The season's dates around `today` (ms, UTC midnight): last, current and next. */
function occurrences(s: Season, today: number): { start: number; end: number }[] {
  const t = new Date(today);
  const y = t.getUTCFullYear();
  const out: { start: number; end: number }[] = [];
  if (s.monthly) {
    const m = t.getUTCMonth() + 1;
    for (let k = -1; k <= 1; k++) {
      const yy = y + Math.floor((m - 1 + k) / 12);
      const mm = ((m - 1 + k + 12) % 12) + 1;
      const start = utcDay(yy, mm, s.monthly.fromDay);
      const wraps = s.monthly.toDay < s.monthly.fromDay;
      const end = wraps ? utcDay(mm === 12 ? yy + 1 : yy, (mm % 12) + 1, s.monthly.toDay) : utcDay(yy, mm, s.monthly.toDay);
      out.push({ start, end });
    }
    return out;
  }
  if (!s.from || !s.to) return out;
  const wraps = s.to[0] < s.from[0] || (s.to[0] === s.from[0] && s.to[1] < s.from[1]);
  for (const yy of [y - 1, y, y + 1]) {
    out.push({ start: utcDay(yy, s.from[0], s.from[1]), end: utcDay(wraps ? yy + 1 : yy, s.to[0], s.to[1]) });
  }
  return out;
}

export type SeasonCard = {
  season: Season;
  /** "soon": starts within the lead time; "now": running today. */
  status: "soon" | "now";
  /** YYYY-MM-DD the season starts (or started). */
  startsOn: string;
  /** "Fall is coming" / "Fall is here". */
  title: string;
};

/**
 * The season to suggest today, or null. A season starting soon wins over the
 * one running now (that is the moment to switch); among running ones, the
 * one that started last (the more specific: holiday catering inside game
 * season). `today` is YYYY-MM-DD.
 */
export function seasonCard(
  key: CategoryKey | null,
  today: string,
  opts: { market: Market; realtyAdType?: string | null },
): SeasonCard | null {
  if (!key) return null;
  const now = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(now)) return null;
  const eligible = SEASONS[key].filter(
    (s) =>
      (!s.markets || s.markets.includes(opts.market)) &&
      (!s.agentAdsOnly || opts.realtyAdType === "agent"),
  );
  let soon: { s: Season; start: number } | null = null;
  let current: { s: Season; start: number } | null = null;
  for (const s of eligible) {
    const lead = (s.monthly ? MONTHLY_LEAD_DAYS : SEASON_LEAD_DAYS) * DAY_MS;
    for (const o of occurrences(s, now)) {
      if (o.end < now) continue;
      if (o.start > now && o.start - lead <= now) {
        if (!soon || o.start < soon.start) soon = { s, start: o.start };
      } else if (o.start <= now) {
        if (!current || o.start > current.start) current = { s, start: o.start };
      }
    }
  }
  const pick = soon ? { ...soon, status: "soon" as const } : current ? { ...current, status: "now" as const } : null;
  if (!pick) return null;
  return {
    season: pick.s,
    status: pick.status,
    startsOn: new Date(pick.start).toISOString().slice(0, 10),
    title: `${pick.s.when} is ${pick.status === "soon" ? "coming" : "here"}`,
  };
}

/** True when the campaign's offer is already this season's (no card then). */
export function alreadyUsingSeason(offerDetails: string | null | undefined, season: Season): boolean {
  const norm = (t: string) => t.replace(/\s+/g, " ").trim().toLowerCase();
  return Boolean(offerDetails) && norm(offerDetails!) === norm(season.offer);
}
// </shared>

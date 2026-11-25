// Browser mirror of api/src/lib/compliance/claimRules.ts. The API is the
// real boundary; the block between the <shared> markers is kept word for word
// by api/src/lib/compliance/mirror.test.ts. Edit the API copy, then this.

import type { CategoryKey } from "../categories/key";

// <shared>
/**
 * block  = refused on save (400 claim_not_allowed).
 * review = saved, the ad can be made, but launch waits for an AdVault admin
 *          (campaigns.compliance_status = needs_review, 409 needs_review).
 * warn   = shown with the reason as the owner types; never stops anything.
 */
export type ClaimLevel = "warn" | "review" | "block";

export type ClaimFlag = {
  id: string;
  level: ClaimLevel;
  /** The words that matched, as typed. */
  phrase: string;
  /** Why, in one or two plain sentences. */
  reason: string;
};

type ClaimRule = {
  id: string;
  /** null = every category. */
  categories: readonly CategoryKey[] | null;
  level: ClaimLevel;
  pattern: RegExp;
  /** The flag is dropped when the text also matches this (e.g. the terms are stated). */
  unless?: RegExp;
  reason: string;
};

const CLAIM_RULES: readonly ClaimRule[] = [
  // --- Housing: Google forbids discriminatory housing ads (blocked). ---
  {
    id: "housing_exclusion",
    categories: ["realEstate"],
    level: "block",
    pattern:
      /\b(no (kids|children|families|section 8|vouchers|immigrants|foreigners)|adults? only|(whites?|christians?|muslims?|hindus?|jewish|men|women|singles|couples|seniors) only|(english|native) speakers only)\b/i,
    reason:
      "Housing ads can't exclude people (Fair Housing Act, Google's housing ads policy). Describe the home, not who may live there.",
  },
  {
    id: "housing_preference",
    categories: ["realEstate"],
    level: "warn",
    pattern:
      /\b(family[- ]friendly|perfect for (a )?(families|family|couples?|singles?|retirees|seniors|students|young professionals)|ideal for (a )?(families|family|couples?|singles?|retirees|seniors|students)|safe (neighbou?rhood|area|street)|exclusive (neighbou?rhood|community|area)|walking distance to (church|mosque|temple|synagogue))\b/i,
    reason:
      "Saying who a home suits, or calling an area safe or exclusive, can break fair housing rules. Describe the home and what is nearby instead.",
  },
  // --- Health (dentistry): Google healthcare rules and the FTC. ---
  {
    id: "health_painless",
    categories: ["dentistry"],
    level: "warn",
    pattern: /\b(painless|pain[- ]free|no pain|100% comfortable)\b/i,
    reason: "Health ads shouldn't promise how treatment will feel. Try “gentle” or “we keep you comfortable”.",
  },
  {
    id: "health_best",
    categories: ["dentistry"],
    level: "warn",
    pattern: /\b(best|top|#1|number one|no\.? ?1) (dentists?|dental (care|office|practice|clinic)|orthodontists?)\b/i,
    reason: "“Best dentist” needs proof Google can check, and health ads are reviewed strictly. Say why people choose you instead.",
  },
  {
    id: "health_guarantee",
    categories: ["dentistry"],
    level: "warn",
    pattern: /\b(guarantee[ds]?|permanent results|cures?|cured|risk[- ]free)\b/i,
    reason: "Health ads can't guarantee results (Google healthcare policy and FTC rules). Say what the visit includes instead.",
  },
  // --- Lawn chemicals: EPA and FTC rules on pesticide safety claims. ---
  {
    id: "lawn_safe",
    categories: ["landscaping"],
    level: "warn",
    pattern:
      /(100\s?%\s*(pet|child|kid|family|people|eco)[- ]?(safe|friendly)|\b(completely|totally|perfectly) safe\b|\bnon[- ]?toxic\b|\bchemical[- ]free\b|\bharmless\b)/i,
    reason:
      "Lawn treatments can't be called 100% safe or non-toxic (EPA rules on pesticide claims). Say what you use and how you apply it.",
  },
  {
    id: "lawn_guaranteed_green",
    categories: ["landscaping"],
    level: "warn",
    pattern: /\b(guaranteed (green|results|lawn)|green (lawn )?guaranteed|weed[- ]free guaranteed|guaranteed weed[- ]free)\b/i,
    reason: "A guaranteed result is a promise you must keep. Say what you do if it doesn't work (for example a free re-treat).",
  },
  // --- Financing: a 0% offer needs its terms (FTC, Truth in Lending). ---
  {
    id: "financing_terms",
    categories: null,
    level: "warn",
    pattern: /(\b0\s?%|\bzero percent|\binterest[- ]free|\bno interest|\bno[- ]money[- ]down|\$0 down)/i,
    unless: /\b(terms|apr|o\.?a\.?c|approved credit|qualified buyers|subject to|see details|conditions apply)\b/i,
    reason: "A 0% or no-interest offer needs its terms in the ad, for example “0% for 12 months with approved credit, see terms”.",
  },
  // --- Every category: superlatives and guarantees. ---
  {
    id: "superlative",
    categories: null,
    level: "warn",
    pattern: /(#1\b|\bnumber one\b|\bno\.? ?1\b|\bbest in (town|the city|the area|[A-Z][a-z]+)\b|\bthe best\b|\bcheapest\b|\blowest price(s)?\b)/i,
    reason: "Google may ask for proof of claims like “#1” or “the best”. Say why instead: years in business, reviews, a price.",
  },
  {
    id: "guarantee",
    categories: ["plumbing", "electrical", "hvac", "restaurant", "auto", "carWash", "cleaning", "realEstate"],
    level: "warn",
    pattern: /\b(guarantee[ds]?|money[- ]back)\b/i,
    reason: "A guarantee is a promise you must keep. Say exactly what it covers.",
  },
  // --- REVIEW (2026-11-20): claims an AdVault admin checks before launch. ---
  // Health: cures and miracle/weight-loss promises (Google healthcare and
  // misrepresentation policies; consumer-protection law in every market).
  {
    id: "review_health_cure",
    categories: null,
    level: "review",
    pattern:
      /\b(cures?|cured|curing|heals?|healed|miracle|miraculous|treats? (cancer|diabetes|arthritis|depression|anxiety|autism|alzheimer'?s|dementia|adhd|obesity|insomnia|covid(-19)?|hair loss|erectile dysfunction|infertility|psoriasis|eczema)|lose \d+\s?(lbs?|pounds|kgs?|kilos?)|weight[- ]loss (guaranteed|promise[ds]?)|guaranteed weight[- ]loss)\b/i,
    reason:
      "Health claims like cures, miracle results or weight-loss promises are checked by AdVault before the ad can run. Say what you offer, not what it will cure.",
  },
  // Finance and crypto: Google restricts financial services and crypto ads.
  {
    id: "review_finance",
    categories: null,
    level: "review",
    pattern:
      /\b(crypto(currency|currencies)?|bitcoin|btc|ethereum|nfts?|forex|guaranteed (returns?|income|profits?)|investment returns?|returns? of \d+\s?%|\d+\s?% (returns?|roi)|double your money|no credit check|payday loans?|cash advance loans?)\b/i,
    reason:
      "Investment, crypto and lending offers are restricted by Google and checked by AdVault before the ad can run.",
  },
  {
    id: "review_guaranteed_results",
    categories: null,
    level: "review",
    pattern: /\b(guaranteed results?|results guaranteed|100\s?% guaranteed)\b/i,
    reason: "A guaranteed result is checked by AdVault before the ad can run. Say exactly what you promise and what happens if it doesn't work.",
  },
];

/** Every flag for this text, blocks first. */
export function claimFlags(key: CategoryKey | null, text: string | null | undefined): ClaimFlag[] {
  const t = text ?? "";
  if (!t.trim()) return [];
  const flags: ClaimFlag[] = [];
  for (const r of CLAIM_RULES) {
    if (r.categories && (!key || !r.categories.includes(key))) continue;
    const m = t.match(r.pattern);
    if (!m) continue;
    if (r.unless && r.unless.test(t)) continue;
    flags.push({ id: r.id, level: r.level, phrase: m[0], reason: r.reason });
  }
  const rank: Record<ClaimLevel, number> = { block: 0, review: 1, warn: 2 };
  return flags.sort((a, b) => rank[a.level] - rank[b.level]);
}

/** The first blocking flag, or null (only these stop a save). */
export function claimBlock(key: CategoryKey | null, text: string | null | undefined): ClaimFlag | null {
  return claimFlags(key, text).find((f) => f.level === "block") ?? null;
}
/** The REVIEW flags for this text (these set needs_review; launch waits for an admin). */
export function claimReviews(key: CategoryKey | null, text: string | null | undefined): ClaimFlag[] {
  return claimFlags(key, text).filter((f) => f.level === "review");
}
// </shared>

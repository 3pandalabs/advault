import { z } from "zod";

// "Show your work: before & after" (2026-11-17, migration 0029). Up to two
// pairs of real photos of one job, a before and an after, attested by the
// advertiser. Pure rules here (tested); the route is routes/beforeAfter.ts.
//
// Mirrored for the browser in web/src/lib/beforeAfter.ts: keep the category
// rules in step.

export const MAX_BEFORE_AFTER_PAIRS = 2;

/**
 * Who may show before & after: trades whose result is the job itself. The
 * wizard's preset categories that qualify are listed exactly; free-text
 * categories ("Other") qualify when they name one of these trades.
 */
export const BEFORE_AFTER_CATEGORIES = [
  "Plumbing",
  "Electrical",
  "HVAC",
  "Landscaping",
  "Auto repair",
  "Cleaning services",
] as const;

const TRADE_PATTERN =
  /\b(contract(or|ors|ing)?|remodel(l?ing|s|ers?)?|renovat(e|ion|ions|ing)|handyman|handymen|roof(s|ing|er|ers)?|gutters?|paint(ing|ers?)?|landscap(e|ing|ers?)|lawns?|yard|garden(ing|ers?)?|tree (service|care|removal)|mow(ing)?|clean(ing|ers?)?|pressure[\s-]?wash(ing)?|power[\s-]?wash(ing)?|window washing|carpet|detail(ing|ers?)?|body ?shop|auto ?body|collision|auto repair|mechanic|floor(s|ing)?|tile|tiling|hardwood|junk|hauling|debris|demolition|hvac|heating|air condition(ing)?|furnace|plumb(ing|ers?)?|drain|sewer|water heater|electric(al|ians?)?|wiring|solar|fenc(e|es|ing)|deck(s|ing)?|patio|concrete|masonry|paving|driveway|siding|drywall|carpent(ry|ers?)|cabinet(s|ry)?|kitchen|bath(room)?s?|countertops?|garage doors?|pool (service|cleaning)|chimney|insulation|restoration|mold remediation|pest control)\b/i;

// Google Ads restricts before/after imagery for personal health and cosmetic
// results, so anything about bodies or health never gets it, whatever trade
// word it also contains ("skin cleaning", "teeth whitening"). Checked FIRST.
const BLOCKED_PATTERN =
  /\b(dent(al|ist|istry|ists)?|orthodont\w*|teeth|tooth|medical|medic|clinic|doctor|physician|health|healthcare|hospital|surg(ery|eon|ical)|cosmetic\w*|aesthetic\w*|botox|filler|derma\w*|skin\w*|facial\w*|laser|lipo\w*|weight|diet\w*|nutrition\w*|fitness|gym|yoga|pilates|personal train\w*|salon|spa|beauty|hair|barber\w*|nails?|lash\w*|brows?|wax(ing)?|makeup|tattoo\w*|piercing|massage|chiro\w*|physio\w*|therap\w*|wellness|med ?spa|plastic|body (contour\w*|sculpt\w*)|pharma\w*|vet(erinary)?|pet groom\w*|bath (and|&) body)\b/i;

// Never shown for these either: food, retail, real estate (housing photos are
// listings, not a job done), whatever else they contain.
const NOT_A_TRADE_PATTERN =
  /\b(restaurant|cafe|coffee|bakery|food|pizza|bar|grill|catering|retail|grocery|boutique|real[\s-]?estate|realt(or|ors|y)|housing|apartments?|condos?|mortgages?)\b/i;

/** True when the category may show before & after photos (ad and website). */
export function beforeAfterAllowed(category: string | null | undefined): boolean {
  const c = (category ?? "").trim();
  if (!c) return false;
  if (BLOCKED_PATTERN.test(c)) return false;
  if ((BEFORE_AFTER_CATEGORIES as readonly string[]).includes(c)) return true;
  if (NOT_A_TRADE_PATTERN.test(c)) return false;
  return TRADE_PATTERN.test(c);
}

export const beforeAfterPairSchema = z.object({
  beforeAssetId: z.string().uuid(),
  afterAssetId: z.string().uuid(),
});
export type BeforeAfterPair = z.infer<typeof beforeAfterPairSchema>;

/** PUT /campaigns/:id/before-after. An empty list removes them. */
export const beforeAfterInputSchema = z.object({
  pairs: z.array(beforeAfterPairSchema).max(MAX_BEFORE_AFTER_PAIRS),
  // Required tick when any pair is added: "These are real photos of our own work."
  attested: z.boolean().optional(),
});
export type BeforeAfterInput = z.infer<typeof beforeAfterInputSchema>;

export type BeforeAfterViolation =
  | "before_after_not_for_category"
  | "before_after_attestation_required"
  | "before_after_same_photo"
  | "before_after_duplicate_photo";

/** The first reason these pairs can't be saved, or null. Ownership is checked by the route. */
export function beforeAfterViolation(category: string, input: BeforeAfterInput): BeforeAfterViolation | null {
  if (input.pairs.length === 0) return null;
  if (!beforeAfterAllowed(category)) return "before_after_not_for_category";
  if (input.attested !== true) return "before_after_attestation_required";
  if (input.pairs.some((p) => p.beforeAssetId === p.afterAssetId)) return "before_after_same_photo";
  const ids = input.pairs.flatMap((p) => [p.beforeAssetId, p.afterAssetId]);
  if (new Set(ids).size !== ids.length) return "before_after_duplicate_photo";
  return null;
}

export const BEFORE_AFTER_DETAIL: Record<BeforeAfterViolation, string> = {
  before_after_not_for_category:
    "Before & after photos are only for trades like contractors, cleaning, landscaping and auto work.",
  before_after_attestation_required: "Tick the box to confirm these are real photos of your own work.",
  before_after_same_photo: "A pair needs two different photos: one before and one after.",
  before_after_duplicate_photo: "Use each photo in only one pair.",
};

/** Every asset id the pairs use. */
export function pairAssetIds(pairs: readonly BeforeAfterPair[] | null | undefined): string[] {
  return (pairs ?? []).flatMap((p) => [p.beforeAssetId, p.afterAssetId]);
}

/** A pair as the renderer sees it: R2 keys, stored on the creative's script. */
export type BeforeAfterKeys = { beforeKey: string; afterKey: string };

/**
 * The honesty rule, in code: a before/after photo gets NO AI photo
 * enhancement and NO AI motion, so both halves of a pair look exactly as the
 * advertiser took them. Returns the indexes into `sourceAssetKeys` that must
 * be left plain (the renderer skips them for both passes). Pair photos are
 * normally never in sourceAssetKeys at all (lib/creatives/generate.ts keeps
 * them out); this catches a key that got there anyway.
 */
export function plainPhotoIndexes(sourceAssetKeys: readonly string[], pairs: readonly BeforeAfterKeys[] | null | undefined): number[] {
  const plain = new Set((pairs ?? []).flatMap((p) => [p.beforeKey, p.afterKey]));
  return sourceAssetKeys.flatMap((k, i) => (plain.has(k) ? [i] : []));
}

/** The ad photos minus any used in a pair (they play only in the before/after scene). */
export function withoutPairPhotos(assetIds: readonly string[], pairs: readonly BeforeAfterPair[] | null | undefined): string[] {
  const used = new Set(pairAssetIds(pairs));
  return assetIds.filter((id) => !used.has(id));
}

/** Seconds per pair in the template ad: before, the wipe, after. */
export const BEFORE_AFTER_PAIR_SECONDS = 3.5;

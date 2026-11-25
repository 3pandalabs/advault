// Browser mirror of api/src/lib/beforeAfter/policy.ts ("Show your work:
// before & after"). The API is the real boundary (it refuses other categories
// and a missing tick); this copy only decides whether the form shows the box.
// Keep the category rules in step with the API's.

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
  "Car wash",
  "Cleaning services",
] as const;

const TRADE_PATTERN =
  /\b(contract(or|ors|ing)?|remodel(l?ing|s|ers?)?|renovat(e|ion|ions|ing)|handyman|handymen|roof(s|ing|er|ers)?|gutters?|paint(ing|ers?)?|landscap(e|ing|ers?)|lawns?|yard|garden(ing|ers?)?|tree (service|care|removal)|mow(ing)?|clean(ing|ers?)?|pressure[\s-]?wash(ing)?|power[\s-]?wash(ing)?|window washing|carpet|detail(ing|ers?)?|body ?shop|auto ?body|collision|auto repair|(car|auto|truck) ?wash|mechanic|floor(s|ing)?|tile|tiling|hardwood|junk|hauling|debris|demolition|hvac|heating|air condition(ing)?|furnace|plumb(ing|ers?)?|drain|sewer|water heater|electric(al|ians?)?|wiring|solar|fenc(e|es|ing)|deck(s|ing)?|patio|concrete|masonry|paving|driveway|siding|drywall|carpent(ry|ers?)|cabinet(s|ry)?|kitchen|bath(room)?s?|countertops?|garage doors?|pool (service|cleaning)|chimney|insulation|restoration|mold remediation|pest control)\b/i;

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

/** What the advertiser ticks before any pair is saved. */
export const BEFORE_AFTER_ATTESTATION = "These are real photos of our own work.";

/** Advertiser-facing sentences for the API's refusals. */
export const BEFORE_AFTER_ERRORS: Record<string, string> = {
  before_after_not_for_category:
    "Before & after photos are only for trades like contractors, cleaning, landscaping and auto work.",
  before_after_attestation_required: "Tick the box to confirm these are real photos of your own work.",
  before_after_same_photo: "A pair needs two different photos: one before and one after.",
  before_after_duplicate_photo: "Use each photo in only one pair.",
  unknown_assets: "One of those photos is no longer in your library. Upload it again.",
};

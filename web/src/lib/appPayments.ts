// Android app: payments on the website only (owner decision 2026-11-26, US-only
// Play launch). See CLAUDE.md "Android app: payments on the website only".
//
// TODO(play-billing): TEMPORARY. Google Play's US rules make in-app Stripe
// payments, or a link out to a payment page, need Google's alternative /
// external-offers program and a ~10% fee. Until we decide on that, the Android
// app (a Bubblewrap TWA wrapping this site) shows NO way to pay and NO link to
// one; people pay on the website in a normal browser. Revisit Play alternative
// billing at 10%, then delete this file's guard and the APP_PAYMENTS_MESSAGE
// placeholders.
//
// Pure helpers take their inputs so `node scripts/app-payments-check.mjs` can
// test them without a browser; the browser wrappers read window/document.

export const ANDROID_APP_PACKAGE = "com.threepandalabs.advault";
const REFERRER_PREFIX = `android-app://${ANDROID_APP_PACKAGE}`;
const STORAGE_KEY = "advault.inAndroidApp";

/**
 * Shown wherever a payment button would be, inside the Android app. Plain
 * text on purpose: no link, no button, no tappable address (a link to the
 * payment page counts as "steering" under Play's rules too).
 */
export const APP_PAYMENTS_MESSAGE =
  "Payments aren't available in the app. To add budget, buy an ad or manage your plan, sign in on our website from any browser.";

/** The API-style error code for a payment refused in the app. */
export const APP_PAYMENTS_ERROR = "payments_unavailable_in_app";

export type AppSignals = {
  referrer?: string | null;
  search?: string | null;
  standalone?: boolean;
  userAgent?: string | null;
  /** What this session already decided ("1" = in the app). */
  remembered?: string | null;
};

/**
 * Is this page running inside the AdVault Android app?
 *  1. document.referrer starts with android-app://com.threepandalabs.advault
 *     (what a TWA sends on launch; lost on in-app navigation, hence 4.)
 *  2. ?source=twa (twa-manifest.json startUrl, from the next app build)
 *  3. fallback: display-mode standalone AND an Android user agent
 *  4. a previous page in this session already said so
 */
export function detectAndroidApp(s: AppSignals): boolean {
  if (s.remembered === "1") return true;
  if ((s.referrer ?? "").startsWith(REFERRER_PREFIX)) return true;
  try {
    if (new URLSearchParams(s.search ?? "").get("source") === "twa") return true;
  } catch {
    // malformed query: not a signal
  }
  return Boolean(s.standalone) && /android/i.test(s.userAgent ?? "");
}

/**
 * The API calls that START a payment (create a checkout). Refused in the app
 * before any request is sent, so no pending purchase is created either.
 * Calls that only SOMETIMES charge stay open so their free case keeps working
 * in the app: confirm an offer change (free when included), make a website
 * (free without the fee), order a new ad (free launch offer), order a
 * cinematic video with pack credits. Their buttons are hidden when they would
 * charge, and `stripCheckoutLinks` drops any checkout link they return.
 */
const PAYMENT_ROUTES: RegExp[] = [
  /^\/wallet\/topup$/, // ad budget top-up
  /^\/subscription$/, // start "Keep it running" (monthly plan)
  /^\/campaigns\/[^/]+\/website\/checkout$/, // $10 website fee
  /^\/offer-changes\/[^/]+\/checkout$/, // paid offer change
  /^\/cinematic\/packs$/, // cinematic 3-pack
];

export function isPaymentRequest(method: string | undefined, path: string): boolean {
  if ((method ?? "GET").toUpperCase() !== "POST") return false;
  const bare = path.split("?")[0];
  return PAYMENT_ROUTES.some((r) => r.test(bare));
}

// --- browser ---------------------------------------------------------------

function readRemembered(): string | null {
  try {
    return window.sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Reads the signals and remembers a "yes" for the rest of the session. */
export function isInAndroidApp(): boolean {
  if (typeof window === "undefined") return false;
  let standalone = false;
  try {
    standalone = window.matchMedia?.("(display-mode: standalone)").matches ?? false;
  } catch {
    // no matchMedia
  }
  const inApp = detectAndroidApp({
    referrer: typeof document !== "undefined" ? document.referrer : null,
    search: window.location.search,
    standalone,
    userAgent: window.navigator?.userAgent ?? null,
    remembered: readRemembered(),
  });
  if (inApp) {
    try {
      window.sessionStorage.setItem(STORAGE_KEY, "1");
    } catch {
      // private mode / blocked storage: detection still works per page
    }
  }
  return inApp;
}

const CHECKOUT_KEYS = new Set(["redirectUrl", "checkoutUrl"]);

/**
 * Backstop for calls that only sometimes charge (make a website with the $10
 * fee, confirm a paid offer change, ...): in the app their response keeps
 * everything except the checkout address, so no screen can navigate to it
 * even if a button was missed. Mutates and returns `value`.
 */
export function stripCheckoutLinks<T>(value: T, depth = 0): T {
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    for (const v of value) stripCheckoutLinks(v, depth + 1);
    return value;
  }
  const obj = value as Record<string, unknown>;
  for (const k of Object.keys(obj)) {
    if (CHECKOUT_KEYS.has(k) && typeof obj[k] === "string") obj[k] = null;
    else stripCheckoutLinks(obj[k], depth + 1);
  }
  return value;
}

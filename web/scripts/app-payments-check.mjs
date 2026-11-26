// node scripts/app-payments-check.mjs: the Android-app detection and the
// payment guard (web/src/lib/appPayments.ts). TODO(play-billing): temporary,
// see CLAUDE.md "Android app: payments on the website only".
import assert from "node:assert";

const m = await import("../src/lib/appPayments.ts");
const { detectAndroidApp, isPaymentRequest, stripCheckoutLinks, APP_PAYMENTS_MESSAGE, ANDROID_APP_PACKAGE } = m;

const ANDROID_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36";
const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1";
const DESKTOP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36";

let n = 0;
const ok = (cond, msg) => {
  assert.ok(cond, msg);
  n++;
};

// --- detection: in the app ---
ok(ANDROID_APP_PACKAGE === "com.threepandalabs.advault", "package matches twa-manifest.json");
ok(detectAndroidApp({ referrer: "android-app://com.threepandalabs.advault/" }), "TWA referrer");
ok(detectAndroidApp({ referrer: "android-app://com.threepandalabs.advault" }), "TWA referrer, no slash");
ok(detectAndroidApp({ search: "?source=twa" }), "?source=twa");
ok(detectAndroidApp({ search: "?foo=1&source=twa" }), "source=twa among other params");
ok(detectAndroidApp({ search: "source=twa" }), "no leading ?");
ok(detectAndroidApp({ standalone: true, userAgent: ANDROID_UA }), "standalone + Android fallback");
ok(detectAndroidApp({ remembered: "1" }), "remembered for the session");
ok(detectAndroidApp({ remembered: "1", referrer: "https://www.google.com/" }), "remembered beats a later referrer");

// --- detection: a normal browser ---
ok(!detectAndroidApp({}), "nothing");
ok(!detectAndroidApp({ referrer: "", search: "", standalone: false, userAgent: ANDROID_UA, remembered: null }), "Android Chrome tab");
ok(!detectAndroidApp({ referrer: "https://advault.3pandalabs.com/dashboard" }), "own-site referrer");
ok(!detectAndroidApp({ referrer: "android-app://com.google.android.gm/" }), "another app's referrer (Gmail link)");
ok(!detectAndroidApp({ referrer: "android-app://com.threepandalabs.sitevault/" }), "another of our apps");
ok(!detectAndroidApp({ search: "?source=twax" }), "source=twax");
ok(!detectAndroidApp({ search: "?source=web" }), "source=web");
ok(!detectAndroidApp({ standalone: true, userAgent: IPHONE_UA }), "iOS home-screen app");
ok(!detectAndroidApp({ standalone: true, userAgent: DESKTOP_UA }), "desktop installed PWA");
ok(!detectAndroidApp({ standalone: false, userAgent: ANDROID_UA }), "Android, not standalone");
ok(!detectAndroidApp({ remembered: "0" }), "remembered value other than 1");
ok(!detectAndroidApp({ referrer: null, search: null, userAgent: null }), "nulls");

// --- the guard: calls that start a payment ---
for (const p of [
  "/wallet/topup",
  "/subscription",
  "/campaigns/abc-123/website/checkout",
  "/offer-changes/xyz/checkout",
  "/cinematic/packs",
  "/wallet/topup?x=1",
]) {
  ok(isPaymentRequest("POST", p), `blocked: POST ${p}`);
  ok(isPaymentRequest("post", p), `blocked (lowercase method): ${p}`);
}
// ... and everything that must keep working in the app
for (const [method, p] of [
  ["GET", "/wallet"],
  ["GET", "/subscription"],
  [undefined, "/subscription"],
  ["PUT", "/subscription/choice"],
  ["POST", "/subscription/cancel"],
  ["PUT", "/subscription/ad-budget"],
  ["POST", "/campaigns/abc/launch"],
  ["POST", "/campaigns/abc/pause"],
  ["POST", "/campaigns/abc/resume"],
  ["PUT", "/campaigns/abc/targeting"],
  ["PATCH", "/campaigns/abc"],
  ["POST", "/campaigns/abc/website"],
  ["POST", "/campaigns/abc/website/use-existing"],
  ["POST", "/campaigns/abc/new-ad/order"], // sometimes free: hidden in the UI instead
  ["POST", "/cinematic/orders"], // pack credits: hidden in the UI when it would charge
  ["POST", "/offer-changes/xyz/confirm"],
  ["POST", "/campaigns/abc/offer-changes"],
  ["GET", "/campaigns/abc/website/checkout"],
  ["POST", "/campaigns/abc/website/checkout/extra"],
  ["POST", "/wallet/topups"],
]) {
  ok(!isPaymentRequest(method, p), `allowed: ${method ?? "GET"} ${p}`);
}

// --- checkout links dropped from responses ---
const website = stripCheckoutLinks({ siteUrl: null, editUrl: "e", checkout: { redirectUrl: "https://checkout.stripe.com/x" } });
ok(website.checkout.redirectUrl === null && website.editUrl === "e", "website checkout link dropped, rest kept");
const offer = stripCheckoutLinks({ ok: true, status: "awaiting_payment", checkoutUrl: "https://checkout.stripe.com/y", display: "$2" });
ok(offer.checkoutUrl === null && offer.display === "$2", "offer change checkout link dropped");
const list = stripCheckoutLinks([{ redirectUrl: "https://a" }, { nested: { checkoutUrl: "https://b" } }]);
ok(list[0].redirectUrl === null && list[1].nested.checkoutUrl === null, "arrays and nesting");
const other = stripCheckoutLinks({ landingUrl: "https://shop.example", videoUrl: "v", billingUrl: "g", redirectUrl: null });
ok(other.landingUrl === "https://shop.example" && other.videoUrl === "v" && other.billingUrl === "g" && other.redirectUrl === null, "other URLs untouched");
ok(stripCheckoutLinks(null) === null && stripCheckoutLinks("x") === "x", "non-objects pass through");

// --- the message: plain, one sentence pair, no link ---
ok(APP_PAYMENTS_MESSAGE.length > 0 && APP_PAYMENTS_MESSAGE.length < 200, "message is short");
ok(!/https?:|www\.|\.com|<a\b/i.test(APP_PAYMENTS_MESSAGE), "message carries no address or link");

console.log(`app-payments-check: ${n} checks passed`);

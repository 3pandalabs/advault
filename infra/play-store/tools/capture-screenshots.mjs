// Captures the three public screenshots (home, demos, pricing) from the live
// site at phone size, 1080 x 1920 (360 x 640 CSS px at 3x). The signed-in ones
// (04-photos, 05-campaign, 06-results) are taken on a phone from the installed
// app: drop them in ../screenshots/raw/ at 1080 x 1920 (crop if needed), then
// `npm run frame`.
//
//   cd infra/play-store/tools && npm install && npm run screenshots
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const RAW = here("../screenshots/raw/");
const SITE = process.env.AV_SITE ?? "https://advault.3pandalabs.com";
mkdirSync(RAW, { recursive: true });

// [file, CSS selector to scroll to the top of (null = page top)]
const SHOTS = [
  ["01-home.png", null],
  ["02-demos.png", "#ads"],
  ["03-pricing.png", "#pricing"],
];

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 360, height: 640 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
});
await page.goto(SITE, { waitUntil: "networkidle" });
// Hides the Next.js dev-mode badge when capturing from `next dev`.
await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
for (const [file, selector] of SHOTS) {
  if (selector) {
    const el = page.locator(selector).first();
    if (!(await el.count())) {
      console.warn(`skip ${file}: no ${selector} on the page`);
      continue;
    }
    await el.evaluate((n) => window.scrollTo(0, n.getBoundingClientRect().top + window.scrollY - 8));
  } else {
    await page.evaluate(() => window.scrollTo(0, 0));
  }
  await page.waitForTimeout(800);
  await page.screenshot({ path: RAW + file });
  console.log(`captured ${file}`);
}
await browser.close();

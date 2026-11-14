// Captioned versions of the raw screenshots for the Play listing: a 1080 x 1920
// canvas in AdVault's brand colours (dark: bg #09090b, fg #fafafa, amber accent
// #f5c242, plus the site backdrop's amber/pink wash), a headline on top, the
// phone screenshot below with rounded corners.
//
//   cd infra/play-store/tools && npm install && npm run frame
//   in:  ../screenshots/raw/*.png   out: ../screenshots/framed/<same name>.png
import { chromium } from "playwright";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const RAW = process.env.AV_RAW ?? here("../screenshots/raw/");
const OUT = process.env.AV_FRAMED ?? here("../screenshots/framed/");
const files = existsSync(RAW) ? readdirSync(RAW).filter((f) => f.endsWith(".png")).sort() : [];
if (!files.length) throw new Error("No PNGs in screenshots/raw/: add 1080x1920 captures first (README.md).");
mkdirSync(OUT, { recursive: true });

// [headline, sub line], by raw file name. Anything else gets its file name.
const CAPTIONS = {
  "01-home.png": ["Your business on YouTube", "Ads made from your own photos"],
  "02-demos.png": ["See what you get", "Real ads, made for local businesses"],
  "03-pricing.png": ["Simple pricing", "$10 per ad. $19 a month to keep it running"],
  "04-photos.png": ["Snap or pick a few photos", "Your shop, your team, your work"],
  "05-campaign.png": ["Pick your area and budget", "We launch it on YouTube for you"],
  "06-results.png": ["See views, clicks and spend", "Every day, right in the app"],
};

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const html = (img, [title, sub]) => `<!doctype html><html><head>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@500;700&display=swap" rel="stylesheet">
<style>
  html,body{margin:0}
  .c{width:1080px;height:1920px;box-sizing:border-box;overflow:hidden;font-family:Inter,system-ui,sans-serif;
     display:flex;flex-direction:column;align-items:center;
     background:radial-gradient(70% 38% at 0% 0%, rgba(245,194,66,.30) 0%, transparent 70%),
                radial-gradient(60% 34% at 100% 4%, rgba(244,114,182,.22) 0%, transparent 70%),#09090b}
  .t{height:420px;display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center;padding:0 90px;box-sizing:border-box}
  h1{margin:0;font-size:76px;line-height:1.1;font-weight:700;letter-spacing:-1.5px;color:#fafafa}
  p{margin:26px 0 0;font-size:40px;line-height:1.25;font-weight:500;color:#f5c242}
  .phone{width:840px;padding:18px;border-radius:64px;background:#27272a;box-shadow:0 40px 80px -24px rgba(245,194,66,.35)}
  img{display:block;width:100%;border-radius:48px}
</style></head><body><div class="c"><div class="t"><h1>${esc(title)}</h1><p>${esc(sub)}</p></div>
<div class="phone"><img src="data:image/png;base64,${img}"></div></div></body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });
for (const f of files) {
  const caption = CAPTIONS[f] ?? [f.replace(/^\d+-|\.png$/g, "").replace(/-/g, " "), ""];
  await page.setContent(html(readFileSync(RAW + f).toString("base64"), caption), { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: OUT + f });
  console.log(`framed ${f}  "${caption[0]}"`);
}
await browser.close();

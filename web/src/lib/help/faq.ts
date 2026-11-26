import { timesShownEstimate } from "@/lib/budget";
import { ADD_MORE_LINE } from "@/lib/spread";

// Shown on /faq and used by the panda helper (topics.ts).
// Prices here match the landing page (see the comment there): change them
// together. Times-shown numbers always come from timesShownEstimate.
const EST = timesShownEstimate(3_500, "USD");
const SHOWN_WORDS = `${EST.low.toLocaleString("en-US")} to ${EST.high.toLocaleString("en-US")}`;

export const FAQ = [
  {
    q: "I don't have a website. Can I still advertise?",
    a: "Yes. Make your ad without one; Google needs a link before the ad goes live, so press Make me a website on your campaign. The website builder opens already filled in with your business, offer and photos, you change anything you like, and your site gets call and directions buttons. You can show your ad video on it when you launch. It's $10 once, and Pro (visitor stats) stays included while your AdVault plan runs.",
  },
  {
    q: "Do I need a Google Ads or YouTube account?",
    a: "No. We create and run the ad account for you. You never log in to Google Ads, and you don't need a YouTube channel. Setting it up is usually quick, and we'll email you as soon as your ad account is ready.",
  },
  {
    q: "What does it cost to keep my ad running?",
    a: `From $55 a month. The first month: your ad $10 (made once), your website $10, the AdVault plan $0 (first month included) and your ad budget, from $35. Every month after, while your ad runs: the $20 plan plus your monthly ad budget (from $35), recharged each month; you can change the amount anytime, and it applies from your next monthly payment. $35 makes it $55 a month, $100 makes it $120. 100% of the ad budget goes to Google. AdVault earns only its own fees: $10 per ad, $10 for a website, the $20 plan, and $2 extras you choose (an extra offer change, or your offer on your website). ${ADD_MORE_LINE}`,
  },
  {
    q: "Can I pay just once?",
    a: "Yes. Pick \"Just this once\" when you launch: the same payment today (your ad, your website and your ad budget), no plan and no renewals. Your ad stops when the budget runs out, and an AdVault-made website stays live with a year of Pro. You can turn on Keep it running later; it then starts that day at $20 plus your monthly ad budget.",
  },
  {
    q: "What happens to ad budget I don't use?",
    a: "You only pay for what Google actually delivers. Unused ad budget stays in your account for your next ad, and if you leave we refund it.",
  },
  {
    q: "How often will my ad be shown?",
    a: `For a $35 ad budget we estimate your ad is shown ${SHOWN_WORDS} times to people near you, depending on your area. It's an estimate, not a guarantee. Your results screen shows the real numbers. ${ADD_MORE_LINE}`,
  },
  {
    q: "Is there a contract?",
    a: "No. Stop renewing anytime in one click on your Subscription page, or pause: no fee and no ad-budget recharge while paused. When no ad is running, the $20 plan stops at the end of the month you've paid for. An ad that stopped only because its budget ran out still counts as running: the next month's budget switches it back on, so pause it if you want the plan to stop. Resume and it starts again. Or pay just once and never renew. The videos we made are yours to keep.",
  },
  {
    q: "Can I change my ad later?",
    a: "Yes. If only the offer changes, use Change my offer on your running ad: one change a month is included with the plan, and each extra change (or any change without the plan) is $2. A completely new ad, with new photos or a new idea, is $10, the same as the first.",
  },
  {
    q: "I already have a video. Can I use it?",
    a: "Uploading your own video isn't open to everyone right now. Send us a message from the Contact us page and we'll help. We check every video before it runs, including that it has no copyrighted music.",
  },
  {
    q: "I'm a real estate agent. Is that allowed?",
    a: "Yes. US housing ads follow Google's fair-housing rules, so we show your listing to people within a distance of the property instead of by ZIP code, age or gender. We set that up for you.",
  },
];

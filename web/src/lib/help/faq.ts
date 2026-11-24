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
    a: "Yes. Make your ad without one; Google needs a link before the ad goes live, so press Make me a website on your campaign and we build a one-page website from your ad in minutes: your photos, offer and video, with call and directions buttons. It's $10 once, and Pro (visitor stats) stays included while your AdVault plan runs.",
  },
  {
    q: "Do I need a Google Ads or YouTube account?",
    a: "No. We create and run the ad account for you. You never log in to Google Ads, and you don't need a YouTube channel.",
  },
  {
    q: "What does it cost to keep my ad running?",
    a: `From $55 a month. The first month: your ad $10 (made once), your website $10, the AdVault plan $0 (first month included) and your ad budget, from $35. Every month after, while your ad runs: the $20 plan plus your monthly ad budget (from $35), recharged each month; change it anytime. $35 makes it $55 a month, $100 makes it $120. 100% of the ad budget goes to Google, and AdVault earns only the $10s and the $20. ${ADD_MORE_LINE}`,
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
    a: "No. Stop renewing anytime in one click on your Subscription page, or pause: no fee and no ad-budget recharge while paused. When no ad is running, the $20 plan stops at the end of the month you've paid for, and you're never charged for a month with no ad running. Resume and it starts again. Or pay just once and never renew. The videos we made are yours to keep.",
  },
  {
    q: "Can I change my ad later?",
    a: "Yes. A new ad is $10, the same as the first. Make one when you have a new offer, a new season or new photos.",
  },
  {
    q: "I already have a video. Can I use it?",
    a: "Yes, and there is no $10 fee for it, because we did not make it. Upload it instead of photos. We check every uploaded video before it runs, including that it has no copyrighted music.",
  },
  {
    q: "I'm a real estate agent. Is that allowed?",
    a: "Yes. US housing ads follow Google's fair-housing rules, so we show your listing to people within a distance of the property instead of by ZIP code, age or gender. We set that up for you.",
  },
];

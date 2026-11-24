import { FAQ } from "@/lib/help/faq";
import type { HelpTopic } from "@/lib/help/match";

// What the panda helper can answer. FAQ answers are reused word for word from
// faq.ts; the rest say where a thing is in the app. Keep them true when a
// screen moves or a price changes. Check with: node scripts/help-check.mjs

const faq = (starts: string) => {
  const item = FAQ.find((f) => f.q.startsWith(starts));
  if (!item) throw new Error(`help: no FAQ starting "${starts}"`);
  return item;
};

const ADS = { label: "Campaigns", href: "/dashboard" };
const BALANCE = { label: "Balance", href: "/dashboard/wallet" };
const PLAN = { label: "Subscription", href: "/dashboard/subscription" };

export const TOPICS: HelpTopic[] = [
  {
    id: "price",
    ...faq("What does it cost"),
    keys: ["price", "pricing", "cost", "fee", "charge", "how much", "month pay", "calculate price", "calculated", "price calculate", "plan price", "expensive", "cheap", "subscription cost", "website cost", "$55"],
    links: [{ label: "See pricing", href: "/#pricing" }, { label: "Cost calculator", href: "/dashboard/costs" }],
  },
  {
    id: "audience",
    q: "Can I change my target audience?",
    a: "Yes. Once your ad is launched, open it from Campaigns and use \"Who should see it\" to change who sees it. Narrowing it can make your ad show less. ZIP codes are chosen before launch; to change them after, send us a message. US real estate ads follow fair-housing rules, so they can't be narrowed by ZIP code, age, gender or parental status.",
    keys: ["audience", "target", "targeting", "target audience", "change audience", "age", "gender", "men women", "who see", "zip", "zip code", "area", "location", "radius", "neighborhood", "city"],
    links: [ADS],
  },
  {
    id: "schedule",
    q: "Can I choose the days and hours my ad shows?",
    a: "Yes. Open your launched ad from Campaigns and use \"When it shows\".",
    keys: ["schedule", "hours", "days hours", "day show", "time show", "weekend", "evening", "when show", "time day"],
    links: [ADS],
  },
  { id: "once", ...faq("Can I pay just once"), keys: ["pay once", "just once", "one time", "onetime", "single payment", "without subscription"], links: [PLAN] },
  {
    id: "contract",
    ...faq("Is there a contract"),
    keys: ["contract", "cancel", "cancel subscription", "cancel plan", "stop renew", "renew", "commitment", "unsubscribe", "end plan"],
    links: [PLAN],
  },
  {
    id: "pause",
    q: "How do I pause or restart my ad?",
    a: "Open your ad from Campaigns and press Pause my ad. Press Resume my ad to start it again. With no ad running, the $20 plan stops at the end of the month you've paid for.",
    keys: ["pause", "resume", "restart", "stop ad", "turn off", "switch off", "hold ad"],
    links: [ADS],
  },
  {
    id: "unused",
    ...faq("What happens to ad budget"),
    keys: ["unused", "dont use budget", "ad budget use", "refund", "leftover", "left over", "money back", "remaining budget", "unused budget"],
    links: [BALANCE],
  },
  {
    id: "topup",
    q: "How do I add to my ad budget?",
    a: "Open Balance to add a one-time top-up anytime, from $35, or to change your monthly ad budget. A new monthly amount applies from your next payment. Every dollar of ad budget goes to Google.",
    keys: ["top up", "topup", "add budget", "add money", "increase budget", "more budget", "change budget", "budget", "balance", "wallet", "fund"],
    links: [BALANCE, PLAN],
  },
  { id: "shown", ...faq("How often will my ad"), keys: ["how often", "often shown", "times shown", "times", "views", "reach", "impression", "people see"], links: [{ label: "Cost calculator", href: "/dashboard/costs" }] },
  {
    id: "results",
    q: "Where do I see how my ad is doing?",
    a: "Open your ad from Campaigns: \"How your ad is doing\" shows times shown, clicks and what you've spent. Google's first numbers take a little while after launch.",
    keys: ["result", "performance", "stats", "statistics", "report", "click", "working", "ad doing", "analytics", "numbers", "track"],
    links: [ADS],
  },
  { id: "website", ...faq("I don't have a website"), keys: ["without website", "dont website", "make website", "website", "web page", "site"], links: [{ label: "Your website", href: "/dashboard/website" }] },
  {
    id: "editsite",
    q: "How do I edit my website?",
    a: "If AdVault made your website, open Website at the top of your dashboard and change the text, photos, style and hours there.",
    keys: ["edit website", "change website", "update website", "website photo", "website style", "website hours", "web address"],
    links: [{ label: "Your website", href: "/dashboard/website" }],
  },
  { id: "accounts", ...faq("Do I need a Google Ads"), keys: ["google ads account", "google account", "youtube account", "youtube channel", "need account", "google login", "channel"], links: [] },
  { id: "change", ...faq("Can I change my ad later"), keys: ["change ad", "edit ad", "new ad", "another ad", "update ad", "second ad", "change video", "change photo", "redo"], links: [ADS] },
  {
    id: "offer",
    q: "Can I change the offer in my running ad?",
    a: "Yes. Open your ad from Campaigns and use \"Change my offer\". You see a preview before anything goes live, and Google checks the new ad first. One change a month is included with the plan; extra changes, or changes without the plan, are $2 each.",
    keys: ["offer", "change offer", "new offer", "discount", "promotion", "coupon", "deal", "sale"],
    links: [ADS],
  },
  { id: "video", ...faq("I already have a video"), keys: ["own video", "my video", "existing video", "already video", "upload video"], links: [{ label: "Contact us", href: "/contact" }] },
  { id: "realty", ...faq("I'm a real estate agent"), keys: ["real estate", "realtor", "realty", "agent", "housing", "open house", "listing", "property"], links: [] },
  {
    id: "start",
    q: "How do I make an ad?",
    a: "Create an account, add a few photos, your business and your offer, and pick the area. The ad is $10, paid before we make it. You check the video, then launch it on YouTube.",
    keys: ["start", "begin", "make ad", "create ad", "how work", "get started", "sign up", "signup", "create account", "register", "how advault work"],
    links: [{ label: "Make an ad", href: "/dashboard/campaigns/new" }, { label: "Create an account", href: "/signup" }],
  },
  {
    id: "where",
    q: "Where does my ad show?",
    a: "On YouTube, including Shorts, to people in your area. AdVault doesn't run ads on Facebook, Instagram or TikTok.",
    keys: ["facebook", "instagram", "tiktok", "shorts", "where ad show", "where show", "which platform", "platform", "youtube show", "tv"],
  },
  {
    id: "review",
    q: "When will my ad go live?",
    a: "After you launch, Google reviews the ad before it shows. Your ad's page shows Google's answer: under review, approved or disapproved. If it was disapproved, send us a message and we'll look at it.",
    keys: ["go live", "approve", "approved", "approval", "disapproved", "rejected", "review", "under review", "pending"],
    links: [ADS],
  },
  {
    id: "login",
    q: "I can't sign in",
    a: "Use \"Forgot password\" and we'll email you a link to choose a new one. It works once and expires in 30 minutes.",
    keys: ["password", "login", "log in", "sign in", "signin", "forgot", "reset password", "locked"],
    links: [{ label: "Forgot password", href: "/forgot-password" }, { label: "Sign in", href: "/login" }],
  },
  {
    id: "delete",
    q: "How do I delete my account?",
    a: "Open Settings and choose Delete account. It shows what happens to your ads and any unused ad budget before you confirm. It also ends your SiteVault sign-in, because the account is shared.",
    keys: ["delete account", "close account", "remove account", "delete data", "delete"],
    links: [{ label: "Settings", href: "/dashboard/settings" }],
  },
  {
    id: "report",
    q: "Something is wrong with an ad I saw",
    a: "Every ad we publish on YouTube has a \"Report this ad\" link in its description. You can also send us a message.",
    keys: ["report ad", "wrong ad", "ad saw", "complain", "complaint", "scam", "misleading", "offensive"],
    links: [{ label: "Report an ad", href: "/report" }],
  },
];

/** Offered before anything is typed. */
export const STARTERS = ["price", "audience", "once", "website", "results"];

// Customer emails (2026-11-26, owner request). Pure: no db, no fetch, no env.
//
// The Android app sells nothing, so email is where a customer learns what to do
// next and where to pay: every one of these links back to the website. They go
// to the customer's own account email, from advault@3pandalabs.com as "AdVault"
// (one of the gateway's APP_SENDERS for advault; never the password-reset
// sender). Each has a text part, the link in both parts, and every value we did
// not write ourselves (names, campaign titles) HTML-escaped.
//
// Copy rules: short, plain, friendly; real numbers only (balance, daily budget,
// days left come from the wallet). No prices are quoted here at all.
import type { Message } from "../mailer.js";

export const CUSTOMER_FROM = "advault@3pandalabs.com";
export const CUSTOMER_FROM_NAME = "AdVault";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
/** Names from the database go on one line, trimmed, never too long for a subject. */
export const oneLine = (s: string | null | undefined, max = 80): string =>
  (s ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

type Body = {
  subject: string;
  /** "Hi Maria," etc. */
  greeting: string;
  paragraphs: string[];
  cta: { label: string; url: string };
  after?: string[];
};

const FOOTER = "AdVault by 3PandaLabs. You get this email because you have an AdVault account.";

function render(to: string, b: Body): Message {
  const p = (t: string) => `<p style="margin:0 0 14px">${esc(t)}</p>`;
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#ffffff;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#0f172a;line-height:1.5">
<div style="max-width:560px">
  <p style="margin:0 0 18px;font-size:18px;font-weight:700">AdVault</p>
  ${p(b.greeting)}
  ${b.paragraphs.map(p).join("\n  ")}
  <p style="margin:20px 0"><a href="${esc(b.cta.url)}" style="display:inline-block;background:#1e293b;color:#ffffff;padding:11px 22px;border-radius:8px;text-decoration:none;font-weight:700">${esc(b.cta.label)}</a></p>
  ${(b.after ?? []).map(p).join("\n  ")}
  <p style="margin:18px 0 0;color:#94a3b8;font-size:12px">Or paste this link into your browser:<br>${esc(b.cta.url)}</p>
  <p style="margin:18px 0 0;color:#94a3b8;font-size:12px">${esc(FOOTER)}</p>
</div>
</body></html>`;
  const text = [b.greeting, ...b.paragraphs, `${b.cta.label}: ${b.cta.url}`, ...(b.after ?? []), FOOTER].join("\n\n") + "\n";
  return { to, from: CUSTOMER_FROM, fromName: CUSTOMER_FROM_NAME, subject: b.subject, text, html };
}

const greet = (name?: string | null) => {
  const n = oneLine(name, 60);
  return n ? `Hi ${n},` : "Hi,";
};
const HELP = "Questions? Just reply to this email.";

/** 1. After sign-up. */
export function welcomeMail(to: string, a: { origin: string; name?: string | null }): Message {
  return render(to, {
    subject: "Welcome to AdVault",
    greeting: greet(a.name),
    paragraphs: [
      "Welcome to AdVault. Your account is ready.",
      "Start with your first ad: tell us about your business and your offer, add a few photos, and pick the area you want to reach. We make the video, and you check it before anything goes live.",
    ],
    cta: { label: "Make your first ad", url: `${a.origin}/dashboard/campaigns/new` },
    after: [HELP],
  });
}

/** 2. The managed ad account's billing went pending -> active. */
export function adAccountReadyMail(
  to: string,
  a: { origin: string; name?: string | null; campaign?: { id: string; name: string } | null },
): Message {
  const campaignName = a.campaign ? oneLine(a.campaign.name) : "";
  return render(to, {
    subject: "Your AdVault ad account is ready",
    greeting: greet(a.name),
    paragraphs: [
      "Good news: your ad account is set up, so your ad can go live now.",
      a.campaign
        ? `Open ${campaignName ? `"${campaignName}"` : "your campaign"}, add to your ad budget if you haven't yet, and press Launch.`
        : "Open your dashboard, add to your ad budget if you haven't yet, and launch your ad.",
    ],
    cta: a.campaign
      ? { label: "Launch your ad", url: `${a.origin}/dashboard/campaigns/${encodeURIComponent(a.campaign.id)}` }
      : { label: "Open your dashboard", url: `${a.origin}/dashboard` },
    after: [HELP],
  });
}

/** 3. Every video of one make is rendered and on YouTube. */
export function adReadyMail(
  to: string,
  a: { origin: string; name?: string | null; campaign: { id: string; name: string; businessName?: string | null } },
): Message {
  const campaignName = oneLine(a.campaign.name);
  const business = oneLine(a.campaign.businessName);
  return render(to, {
    subject: campaignName ? `Your ad is ready: ${campaignName}` : "Your ad is ready",
    greeting: greet(a.name),
    paragraphs: [
      `Your video ad${business ? ` for ${business}` : ""} is made and ready.`,
      "Watch it on your campaign page. When you're happy with it, launch it from there.",
    ],
    cta: { label: "See your ad", url: `${a.origin}/dashboard/campaigns/${encodeURIComponent(a.campaign.id)}` },
    after: [HELP],
  });
}

/** 4. The shared ad budget dipped under the low line (once per episode). */
export function lowBudgetMail(
  to: string,
  a: {
    origin: string;
    name?: string | null;
    /** Formatted, e.g. "$8.50". */
    balance: string;
    /** Formatted sum of the live campaigns' daily budgets, e.g. "$5". */
    daily: string;
    daysLeft: number;
    /** Exactly one campaign: link straight to its budget card; otherwise the Balance page. */
    campaign?: { id: string; name: string } | null;
  },
): Message {
  const days = a.daysLeft <= 1 ? "about 1 day" : `about ${a.daysLeft} days`;
  return render(to, {
    subject: "Your AdVault ad budget is running low",
    greeting: greet(a.name),
    paragraphs: [
      `Your ad budget has ${a.balance} left. That's ${days} at ${a.daily} a day.`,
      "When it runs out, your ad pauses by itself so nothing overspends. Add to your ad budget to keep it showing; a paused ad starts again by itself once the budget is topped up.",
    ],
    cta: {
      label: "Add to your ad budget",
      url: a.campaign
        ? `${a.origin}/dashboard/campaigns/${encodeURIComponent(a.campaign.id)}#ad-budget`
        : `${a.origin}/dashboard/wallet`,
    },
    after: [HELP],
  });
}

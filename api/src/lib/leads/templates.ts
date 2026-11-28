// Leads inbox emails. Pure: no db, no network (templates.test.ts).
// Owner emails go from sitevault@3pandalabs.com as "SiteVault" (the lead came
// from their SiteVault site) with Reply-To = the customer, so the owner just
// hits Reply. Customer emails go from the same sender with the business name
// in the display name and Reply-To = the owner.
import type { Message } from "../mailer.js";
import { formatBookingTime } from "./policy.js";
import type { LeadKind } from "../../db/schema.js";

export const LEADS_FROM = "sitevault@3pandalabs.com";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** A display name the mailer can put in From: no quotes, brackets or line breaks. */
export function displayName(name: string): string {
  return oneLine(name).replace(/["<>\\,;@]/g, "").slice(0, 60).trim() || "SiteVault";
}

export type LeadForEmail = {
  id: string;
  kind: LeadKind;
  name: string;
  phone: string;
  email: string | null;
  message: string | null;
  bestTime: string | null;
  photoUrls: string[];
  bookingService: string | null;
  bookingDurationMin: number | null;
  bookingStart: Date | null;
  bookingTimezone: string | null;
  fromAd: boolean;
};

const KIND_LABEL: Record<LeadKind, string> = {
  quote: "quote request",
  callback: "call-back request",
  booking: "booking request",
};

type Row = [label: string, value: string];

function wrap(paragraphsHtml: string): string {
  return `<!doctype html><html><body style="margin:0;padding:24px;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#0f172a;line-height:1.5;max-width:560px">
  ${paragraphsHtml}
</body></html>`;
}

function button(label: string, url: string, color = "#1e293b"): string {
  return `<a href="${esc(url)}" style="display:inline-block;background:${color};color:#ffffff;padding:11px 22px;border-radius:8px;text-decoration:none;font-weight:700;margin:4px 8px 4px 0">${esc(label)}</a>`;
}

/** The owner's "New quote request from Sam" email. */
export function ownerLeadMail(
  to: string,
  lead: LeadForEmail,
  links: { inbox: string; confirm: string | null; decline: string | null },
): Message {
  const when = lead.bookingStart ? formatBookingTime(lead.bookingStart, lead.bookingTimezone) : null;
  const subject =
    lead.kind === "booking"
      ? `New booking request: ${oneLine(lead.bookingService ?? "Booking")}, ${when}`
      : `New ${KIND_LABEL[lead.kind]} from ${oneLine(lead.name)}`;
  const rows: Row[] = [
    ["Name", oneLine(lead.name)],
    ["Phone", oneLine(lead.phone)],
    ...(lead.email ? ([["Email", lead.email]] as Row[]) : []),
    ...(lead.kind === "booking" && lead.bookingService
      ? ([
          ["Service", oneLine(lead.bookingService)],
          ["When", `${when}${lead.bookingDurationMin ? ` (${lead.bookingDurationMin} min)` : ""}`],
        ] as Row[])
      : []),
    ...(lead.bestTime ? ([["Best time to call", oneLine(lead.bestTime)]] as Row[]) : []),
    ...(lead.fromAd ? ([["Came from", "Your AdVault ad"]] as Row[]) : []),
  ];
  const intro = `Someone sent a ${KIND_LABEL[lead.kind]} from your website.`;
  const photos = lead.photoUrls.slice(0, 10);
  const bookingAsk =
    lead.kind === "booking"
      ? links.confirm && links.decline
        ? "Can you take it? One tap tells them."
        : "Open your leads in AdVault to confirm or decline it."
      : null;

  const textParts = [
    intro,
    rows.map(([k, v]) => `${k}: ${v}`).join("\n"),
    ...(lead.message ? [`Message:\n${lead.message}`] : []),
    ...(photos.length ? [`Photos:\n${photos.join("\n")}`] : []),
    ...(bookingAsk ? [bookingAsk] : []),
    ...(links.confirm && links.decline ? [`Confirm: ${links.confirm}\nDecline: ${links.decline}`] : []),
    `All your leads: ${links.inbox}`,
    lead.email ? "Reply to this email to answer them." : "They left no email, so call or text them back.",
  ];
  const html = wrap(`<p>${esc(intro)}</p>
  <table style="border-collapse:collapse;font-size:15px">${rows
    .map(([k, v]) => `<tr><td style="padding:3px 14px 3px 0;color:#64748b">${esc(k)}</td><td style="padding:3px 0">${esc(v)}</td></tr>`)
    .join("")}</table>
  ${lead.message ? `<p style="white-space:pre-wrap;border-left:3px solid #e2e8f0;padding-left:12px">${esc(lead.message)}</p>` : ""}
  ${photos.length ? `<p>Photos: ${photos.map((u, i) => `<a href="${esc(u)}">photo ${i + 1}</a>`).join(" · ")}</p>` : ""}
  ${bookingAsk ? `<p>${esc(bookingAsk)}</p>` : ""}
  ${links.confirm && links.decline ? `<p>${button("Confirm", links.confirm, "#15803d")}${button("Decline", links.decline, "#b91c1c")}</p>` : ""}
  <p>${button("See all your leads", links.inbox)}</p>
  <p style="color:#64748b;font-size:13px">${esc(lead.email ? "Reply to this email to answer them." : "They left no email, so call or text them back.")}</p>`);
  return {
    to,
    from: LEADS_FROM,
    fromName: "SiteVault",
    subject,
    text: textParts.join("\n\n"),
    html,
    ...(lead.email ? { replyTo: lead.email } : {}),
  };
}

/** The customer's "your booking is confirmed / can't be taken" email. */
export function customerBookingMail(
  lead: LeadForEmail & { email: string },
  status: "confirmed" | "declined",
  business: { name: string; ownerEmail: string | null; siteUrl: string },
): Message {
  const when = lead.bookingStart ? formatBookingTime(lead.bookingStart, lead.bookingTimezone) : "the time you picked";
  const service = oneLine(lead.bookingService ?? "your booking");
  const biz = oneLine(business.name);
  const first = oneLine(lead.name).split(" ")[0] || "there";
  const paragraphs =
    status === "confirmed"
      ? [
          `Hi ${first},`,
          `Good news: ${biz} confirmed your booking. ${service}, ${when}.`,
          "If you need to change it, just reply to this email.",
        ]
      : [
          `Hi ${first},`,
          `Sorry, ${biz} can't take your booking for ${service} on ${when}.`,
          `You can pick another time on their website: ${business.siteUrl}`,
          "Or reply to this email and they'll get back to you.",
        ];
  return {
    to: lead.email,
    from: LEADS_FROM,
    fromName: displayName(`${biz} via SiteVault`),
    subject: status === "confirmed" ? `Your booking with ${biz} is confirmed` : `About your booking with ${biz}`,
    text: paragraphs.join("\n\n"),
    html: wrap(paragraphs.map((p) => `<p>${esc(p)}</p>`).join("\n  ")),
    ...(business.ownerEmail ? { replyTo: business.ownerEmail } : {}),
  };
}

/** "Would you leave a review?" — sent at most once per lead, only when the owner asks. */
export function reviewRequestMail(
  lead: { name: string; email: string },
  reviewUrl: string,
  business: { name: string; ownerEmail: string | null },
): Message {
  const biz = oneLine(business.name);
  const first = oneLine(lead.name).split(" ")[0] || "there";
  const intro = `Hi ${first}, thanks for choosing ${biz}! If you have a minute, would you leave a short review? It really helps a local business.`;
  const outro = "Thank you. You won't get another email about this.";
  return {
    to: lead.email,
    from: LEADS_FROM,
    fromName: displayName(`${biz} via SiteVault`),
    subject: `How did ${biz} do?`,
    text: `${intro}\n\nLeave a review: ${reviewUrl}\n\n${outro}`,
    html: wrap(`<p>${esc(intro)}</p>
  <p>${button("Leave a review", reviewUrl)}</p>
  <p style="color:#64748b;font-size:13px">${esc(outro)}</p>
  <p style="color:#94a3b8;font-size:12px">Or paste this link into your browser:<br>${esc(reviewUrl)}</p>`),
    ...(business.ownerEmail ? { replyTo: business.ownerEmail } : {}),
  };
}

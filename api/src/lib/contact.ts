import { z } from "zod";
import type { Message } from "./mailer.js";

// Contact-form mail and limits, shared by routes/contact.ts and SiteVault's
// internal route. No database here, so both stay testable without one.

const HOUR = 60 * 60_000;
/** Per IP, and overall: the mailer's daily quota is shared with password resets. */
export const CONTACT_PER_IP_PER_HOUR = 5;
export const CONTACT_PER_HOUR = 20;

const recent: { ip: string | null; at: number }[] = [];
export function resetContactLimits() {
  recent.length = 0;
}

/** Counts this attempt and says whether it may go through. In memory: one API replica. */
export function allowContact(ip: string | null, now: number): boolean {
  while (recent.length && recent[0]!.at <= now - HOUR) recent.shift();
  if (recent.length >= CONTACT_PER_HOUR) return false;
  if (ip && recent.filter((r) => r.ip === ip).length >= CONTACT_PER_IP_PER_HOUR) return false;
  recent.push({ ip, at: now });
  return true;
}

const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const oneLine = (v: string) => v.replace(/\s+/g, " ");

export const contactBody = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(320),
  subject: z.string().trim().min(1).max(150),
  message: z.string().trim().min(1).max(4000),
  // Honeypot: hidden on the form, so only bots fill it.
  website: z.string().max(500).optional(),
});

type ContactInput = Pick<z.infer<typeof contactBody>, "name" | "email" | "subject" | "message">;

/** `SiteVault` messages go to the org inbox SiteVault publishes. */
const PRODUCTS = {
  AdVault: { to: () => process.env.CONTACT_EMAIL || "advault@3pandalabs.com", from: "advault@3pandalabs.com" },
  SiteVault: { to: () => process.env.SITEVAULT_CONTACT_EMAIL || "3pandas@3pandalabs.com", from: "sitevault@3pandalabs.com" },
};

export function contactMail(b: ContactInput, userId?: string, product: keyof typeof PRODUCTS = "AdVault"): Message {
  const who = `${oneLine(b.name)} <${b.email}>${userId ? ` (signed in as user ${userId})` : " (not signed in)"}`;
  const subject = oneLine(b.subject);
  return {
    to: PRODUCTS[product].to(),
    // Not the password-reset default; allowed in the mailer's APP_SENDERS.
    from: PRODUCTS[product].from,
    replyTo: b.email,
    fromName: `${product} contact form`,
    subject: `${product} contact: ${subject}`,
    text: `From: ${who}\nSubject: ${subject}\n\n${b.message}\n\nReply to this email to answer them.`,
    html: `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#1f2937;max-width:560px">
  <p style="font-size:13px;color:#6b7280">From: ${esc(who)}<br>Subject: ${esc(subject)}</p>
  <p style="font-size:15px;line-height:1.6;white-space:pre-wrap">${esc(b.message)}</p>
  <p style="font-size:13px;color:#6b7280">Reply to this email to answer them.</p>
</div>`,
  };
}

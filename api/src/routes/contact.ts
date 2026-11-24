import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { clientIp } from "../lib/compliance/index.js";
import { mailerConfigured, sendMail, type Message } from "../lib/mailer.js";

// The web's /contact form. Public; relays one email to CONTACT_EMAIL with
// Reply-To = the sender and stores nothing. Same shape as TransitVault's.

const HOUR = 60 * 60_000;
/** Per IP, and overall: the mailer's daily quota is shared with password resets. */
export const CONTACT_PER_IP_PER_HOUR = 5;
export const CONTACT_PER_HOUR = 20;

const recent: { ip: string | null; at: number }[] = [];
export function resetContactLimits() {
  recent.length = 0;
}

/** Counts this attempt and says whether it may go through. In memory: one API replica. */
function allow(ip: string | null, now: number): boolean {
  while (recent.length && recent[0]!.at <= now - HOUR) recent.shift();
  if (recent.length >= CONTACT_PER_HOUR) return false;
  if (ip && recent.filter((r) => r.ip === ip).length >= CONTACT_PER_IP_PER_HOUR) return false;
  recent.push({ ip, at: now });
  return true;
}

const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const oneLine = (v: string) => v.replace(/\s+/g, " ");

const contactBody = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(320),
  subject: z.string().trim().min(1).max(150),
  message: z.string().trim().min(1).max(4000),
  // Honeypot: hidden on the form, so only bots fill it.
  website: z.string().max(500).optional(),
});

export function contactMail(b: z.infer<typeof contactBody>, userId?: string): Message {
  const who = `${oneLine(b.name)} <${b.email}>${userId ? ` (signed in as user ${userId})` : " (not signed in)"}`;
  const subject = oneLine(b.subject);
  return {
    to: process.env.CONTACT_EMAIL || "advault@3pandalabs.com",
    replyTo: b.email,
    fromName: "AdVault contact form",
    subject: `AdVault contact: ${subject}`,
    text: `From: ${who}\nSubject: ${subject}\n\n${b.message}\n\nReply to this email to answer them.`,
    html: `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#1f2937;max-width:560px">
  <p style="font-size:13px;color:#6b7280">From: ${esc(who)}<br>Subject: ${esc(subject)}</p>
  <p style="font-size:15px;line-height:1.6;white-space:pre-wrap">${esc(b.message)}</p>
  <p style="font-size:13px;color:#6b7280">Reply to this email to answer them.</p>
</div>`,
  };
}

export async function contactRoutes(app: FastifyInstance) {
  app.post("/contact", { schema: { body: contactBody } }, async (req, reply) => {
    const body = req.body as z.infer<typeof contactBody>;
    if (body.website?.trim()) return reply.code(204).send();
    if (!allow(clientIp(req), Date.now())) return reply.code(429).send({ error: "rate_limited" });
    const res = mailerConfigured()
      ? await sendMail([contactMail(body, req.userId)], (m) => req.log.info(m)).catch((err) => {
          req.log.error(err);
          return null;
        })
      : null;
    // Not fail-soft on purpose: "sent" when nobody will read it is worse.
    if (!res?.delivered) return reply.code(503).send({ error: "mailer_unavailable" });
    return reply.code(204).send();
  });
}

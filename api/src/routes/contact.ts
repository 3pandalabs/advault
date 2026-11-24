import type { FastifyInstance } from "fastify";
import type { z } from "zod";
import { clientIp } from "../lib/compliance/index.js";
import { allowContact, contactBody, contactMail } from "../lib/contact.js";
import { mailerConfigured, sendMail } from "../lib/mailer.js";

// The web's /contact form. Public; relays one email to CONTACT_EMAIL with
// Reply-To = the sender and stores nothing. Same shape as TransitVault's.

export async function contactRoutes(app: FastifyInstance) {
  app.post("/contact", { schema: { body: contactBody } }, async (req, reply) => {
    const body = req.body as z.infer<typeof contactBody>;
    if (body.website?.trim()) return reply.code(204).send();
    if (!allowContact(clientIp(req), Date.now())) return reply.code(429).send({ error: "rate_limited" });
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

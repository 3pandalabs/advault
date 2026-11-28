import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireAuth } from "../auth/plugin.js";
import { leads, users } from "../db/schema.js";
import type { Db } from "../lib/sharedAccount/index.js";
import {
  listLeads,
  loadOwnedLead,
  newLeadCount,
  ownerLeadSlugs,
  requestReview,
  setLeadStatus,
  toPublicLead,
  type OwnerRef,
} from "../lib/leads/index.js";
import { LEAD_KINDS, LEAD_STATUSES, formatBookingTime, verifyLeadLink } from "../lib/leads/policy.js";
import { fetchSitevaultReviewLink } from "../lib/sitevault/index.js";

// The owner's Leads page (/dashboard/leads, 2026-11-27, lib/leads), and the
// one-click Confirm / Decline links in a booking email (/leads/action in web).
//
//   GET  /leads                       my leads (?kind=&status=), + newCount
//   GET  /leads/count                 { new } for the nav badge
//   POST /leads/:id/status            { status }
//   GET  /leads/review-links          { links: { <slug>: url | null } } from SiteVault
//   POST /leads/:id/review-request    email the customer the site's review link
//   POST /leads/link                  PUBLIC: what a signed email link would do
//   POST /leads/link/apply            PUBLIC: do it (the landing page's button)

const idParams = z.object({ id: z.string().uuid() });
const linkBody = z.object({ token: z.string().min(10).max(300) });

export async function leadRoutes(app: FastifyInstance, opts: { db: Db }) {
  const { db } = opts;

  async function me(req: FastifyRequest): Promise<OwnerRef> {
    const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, req.userId!)).limit(1);
    return { userId: req.userId!, email: u?.email ?? null };
  }

  // The signed link in the owner's booking email. Two steps so a mail
  // scanner that opens the link changes nothing: the page shows what it will
  // do, and the owner's tap applies it.
  app.post("/leads/link", { schema: { body: linkBody } }, async (req, reply) => {
    const v = verifyLeadLink((req.body as { token: string }).token);
    if (!v) return reply.code(400).send({ error: "invalid_or_expired_link" });
    const [lead] = await db.select().from(leads).where(eq(leads.id, v.leadId)).limit(1);
    if (!lead || lead.kind !== "booking") return reply.code(404).send({ error: "not_found" });
    return {
      action: v.action,
      status: lead.status,
      name: lead.name,
      service: lead.bookingService,
      when: lead.bookingStart ? formatBookingTime(lead.bookingStart, lead.bookingTimezone) : null,
    };
  });

  app.post("/leads/link/apply", { schema: { body: linkBody } }, async (req, reply) => {
    const v = verifyLeadLink((req.body as { token: string }).token);
    if (!v) return reply.code(400).send({ error: "invalid_or_expired_link" });
    const [lead] = await db.select().from(leads).where(eq(leads.id, v.leadId)).limit(1);
    if (!lead || lead.kind !== "booking") return reply.code(404).send({ error: "not_found" });
    const status = v.action === "confirm" ? "confirmed" : "declined";
    // A finished booking stays finished; a repeat tap is a no-op.
    if (lead.status !== "done" && lead.status !== status) await setLeadStatus(db, lead, status, (m) => req.log.info(m));
    return { status: lead.status === "done" ? "done" : status };
  });

  app.register(async (secured) => {
    secured.addHook("onRequest", requireAuth);

    secured.get(
      "/leads",
      { schema: { querystring: z.object({ kind: z.enum(LEAD_KINDS).optional(), status: z.enum(LEAD_STATUSES).optional() }) } },
      async (req) => {
        const q = req.query as { kind?: (typeof LEAD_KINDS)[number]; status?: (typeof LEAD_STATUSES)[number] };
        const owner = await me(req);
        const [list, n] = await Promise.all([listLeads(db, owner, q), newLeadCount(db, owner)]);
        return { leads: list, newCount: n };
      },
    );

    secured.get("/leads/count", async (req) => ({ new: await newLeadCount(db, await me(req)) }));

    secured.post(
      "/leads/:id/status",
      { schema: { params: idParams, body: z.object({ status: z.enum(LEAD_STATUSES) }) } },
      async (req, reply) => {
        const { id } = req.params as { id: string };
        const lead = await loadOwnedLead(db, id, await me(req));
        if (!lead) return reply.code(404).send({ error: "not_found" });
        const updated = await setLeadStatus(db, lead, (req.body as { status: (typeof LEAD_STATUSES)[number] }).status, (m) =>
          req.log.info(m),
        );
        return { lead: toPublicLead(updated) };
      },
    );

    secured.get("/leads/review-links", async (req) => {
      const slugs = await ownerLeadSlugs(db, await me(req));
      const entries = await Promise.all(slugs.map(async (s) => [s, (await fetchSitevaultReviewLink(s)) ?? null] as const));
      return { links: Object.fromEntries(entries) };
    });

    secured.post("/leads/:id/review-request", { schema: { params: idParams } }, async (req, reply) => {
      const { id } = req.params as { id: string };
      const lead = await loadOwnedLead(db, id, await me(req));
      if (!lead) return reply.code(404).send({ error: "not_found" });
      const url = await fetchSitevaultReviewLink(lead.siteSlug);
      if (url === undefined) return reply.code(502).send({ error: "sitevault_unavailable" });
      if (url === null) return reply.code(409).send({ error: "no_review_link" });
      const r = await requestReview(db, lead, url, (m) => req.log.info(m));
      if (r === "no_email") return reply.code(400).send({ error: "no_customer_email" });
      if (r === "already_sent") return reply.code(409).send({ error: "review_already_requested" });
      if (r === "mailer_unavailable") return reply.code(503).send({ error: "mailer_unavailable" });
      return reply.code(204).send();
    });
  });
}

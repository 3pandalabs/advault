import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../lib/sharedAccount/index.js";
import { bearerOk } from "./sitevaultAuth.js";
import { busySlots, createLead, listLeads, loadOwnedLead, requestReview, setLeadStatus } from "../lib/leads/index.js";
import { LEAD_KINDS, LEAD_STATUSES, SLUG_RE, leadInput, type LeadInput } from "../lib/leads/policy.js";

// Leads from customers' SiteVault sites (2026-11-27, lib/leads). Server to
// server, bearer SITEVAULT_INTERNAL_TOKEN like routes/sitevaultAuth.ts, 401
// before any parsing. SiteVault does the per-visitor limits and spam checks
// on its public forms; this is the store, the owner email and the inbox.
//
//   POST /internal/sitevault/leads                      store a lead (idempotent)
//   GET  /internal/sitevault/leads/busy                 booked slots for a site
//   GET  /internal/sitevault/leads                      an owner's leads
//   POST /internal/sitevault/leads/:id/status           change a lead's status
//   POST /internal/sitevault/leads/:id/review-request   email the customer a review ask

const slug = z.string().trim().toLowerCase().regex(SLUG_RE);
const blank = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const ownerFields = {
  advaultUserId: z.preprocess(blank, z.string().uuid().optional()),
  email: z.preprocess(blank, z.string().trim().toLowerCase().email().max(254).optional()),
};
const needsOwner = (v: { advaultUserId?: string; email?: string }) => Boolean(v.advaultUserId || v.email);
const ownerMessage = { message: "advaultUserId or email is required" };
const idParams = z.object({ id: z.string().uuid() });

export async function sitevaultLeadRoutes(app: FastifyInstance, opts: { db: Db }) {
  const { db } = opts;

  app.addHook("onRequest", async (req, reply) => {
    if (!bearerOk(req.headers.authorization)) return reply.code(401).send({ ok: false, error: "unauthorized" });
  });

  app.post("/internal/sitevault/leads", { schema: { body: leadInput } }, async (req, reply) => {
    const r = await createLead(db, req.body as LeadInput, (m) => req.log.info(m));
    if (r.status === "slot_taken") return reply.code(409).send({ error: "slot_taken" });
    // 201 for a new lead, 200 for an idempotent replay (same leadId).
    return reply.code(r.status === "created" ? 201 : 200).send({ leadId: r.leadId });
  });

  app.get(
    "/internal/sitevault/leads/busy",
    {
      schema: {
        querystring: z
          .object({ slug, from: z.string().datetime({ offset: true }), to: z.string().datetime({ offset: true }) })
          .refine((v) => new Date(v.from) < new Date(v.to), { message: "from must be before to" })
          .refine((v) => new Date(v.to).getTime() - new Date(v.from).getTime() <= 120 * 86_400_000, {
            message: "at most 120 days",
          }),
      },
    },
    async (req) => {
      const q = req.query as { slug: string; from: string; to: string };
      return { busy: await busySlots(db, q.slug, new Date(q.from), new Date(q.to)) };
    },
  );

  app.get(
    "/internal/sitevault/leads",
    {
      schema: {
        querystring: z
          .object({
            slug: slug.optional(),
            ...ownerFields,
            kind: z.enum(LEAD_KINDS).optional(),
            status: z.enum(LEAD_STATUSES).optional(),
          })
          .refine(needsOwner, ownerMessage),
      },
    },
    async (req) => {
      const q = req.query as { slug?: string; advaultUserId?: string; email?: string; kind?: (typeof LEAD_KINDS)[number]; status?: (typeof LEAD_STATUSES)[number] };
      return { leads: await listLeads(db, { userId: q.advaultUserId, email: q.email }, { slug: q.slug, kind: q.kind, status: q.status }) };
    },
  );

  app.post(
    "/internal/sitevault/leads/:id/status",
    {
      schema: {
        params: idParams,
        body: z.object({ status: z.enum(LEAD_STATUSES), ...ownerFields }).refine(needsOwner, ownerMessage),
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const b = req.body as { status: (typeof LEAD_STATUSES)[number]; advaultUserId?: string; email?: string };
      const lead = await loadOwnedLead(db, id, { userId: b.advaultUserId, email: b.email });
      if (!lead) return reply.code(404).send({ error: "not_found" });
      await setLeadStatus(db, lead, b.status, (m) => req.log.info(m));
      return reply.code(204).send();
    },
  );

  app.post(
    "/internal/sitevault/leads/:id/review-request",
    {
      schema: {
        params: idParams,
        body: z
          .object({
            reviewUrl: z.string().url().max(1000).refine((u) => /^https:\/\//i.test(u), { message: "must be https" }),
            ...ownerFields,
          })
          .refine(needsOwner, ownerMessage),
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const b = req.body as { reviewUrl: string; advaultUserId?: string; email?: string };
      const lead = await loadOwnedLead(db, id, { userId: b.advaultUserId, email: b.email });
      if (!lead) return reply.code(404).send({ error: "not_found" });
      const r = await requestReview(db, lead, b.reviewUrl, (m) => req.log.info(m));
      if (r === "no_email") return reply.code(400).send({ error: "no_customer_email" });
      if (r === "already_sent") return reply.code(409).send({ error: "review_already_requested" });
      if (r === "mailer_unavailable") return reply.code(503).send({ error: "mailer_unavailable" });
      return reply.code(204).send();
    },
  );
}

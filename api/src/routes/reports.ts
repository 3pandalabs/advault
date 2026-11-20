import { and, count, desc, eq, gt, inArray } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireAdmin, requireAuth } from "../auth/plugin.js";
import { db } from "../db/index.js";
import { adReports, campaigns, users } from "../db/schema.js";
import { clientIp, clientUserAgent } from "../lib/compliance/index.js";
import { approveAll } from "../lib/compliance/policy.js";
import { REPORT_REASONS, REPORTS_PER_IP_PER_HOUR } from "../lib/compliance/report.js";
import { takeDownCampaign } from "../lib/compliance/takedown.js";
import { notifyOps } from "../lib/ops/notify.js";

// "Report this ad" and the admin side of compliance (2026-11-20, migration
// 0043, CLAUDE.md "Client attestation & compliance").
//
// Public (no session): GET /reports/ad/:publicId (is this ad still up?) and
// POST /reports (rate-limited per IP, pings ops). The id is campaigns.public_id,
// never the internal uuid, so a report link reveals nothing else.
//
// Admin (session with role admin in the JWT AND users.role = admin in the
// database, so a just-demoted admin is refused):
//   GET  /admin/reports                      the report queue
//   POST /admin/reports/:reportId/dismiss
//   POST /admin/campaigns/:campaignId/takedown  (lib/compliance/takedown.ts)
//   GET  /admin/compliance                   campaigns waiting for a wording review
//   POST /admin/compliance/:campaignId/approve

const publicIdSchema = z.string().trim().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/);

const reportBody = z.object({
  ad: publicIdSchema,
  reason: z.enum(REPORT_REASONS),
  details: z.string().trim().max(2000).optional(),
  email: z.string().trim().email().max(320).optional().or(z.literal("")),
});

/** The real role, from the database (the JWT role can be up to 15 minutes stale). */
async function requireRealAdmin(req: FastifyRequest, reply: FastifyReply) {
  const [u] = await db.select({ role: users.role }).from(users).where(eq(users.id, req.userId!)).limit(1);
  if (u?.role !== "admin") return reply.code(403).send({ error: "admin_role_required" });
}

async function findByPublicId(publicId: string) {
  const [c] = await db
    .select({
      id: campaigns.id,
      businessName: campaigns.businessName,
      name: campaigns.name,
      complianceStatus: campaigns.complianceStatus,
    })
    .from(campaigns)
    .where(eq(campaigns.publicId, publicId))
    .limit(1);
  return c ?? null;
}

export async function reportRoutes(app: FastifyInstance) {
  // ---- public ----

  app.get(
    "/reports/ad/:publicId",
    { schema: { params: z.object({ publicId: publicIdSchema }) } },
    async (req, reply) => {
      const c = await findByPublicId((req.params as { publicId: string }).publicId);
      if (!c) return reply.code(404).send({ error: "not_found" });
      if (c.complianceStatus === "taken_down") return { status: "removed" };
      return { status: "active", businessName: c.businessName };
    },
  );

  app.post("/reports", { schema: { body: reportBody } }, async (req, reply) => {
    const body = req.body as z.infer<typeof reportBody>;
    const ip = clientIp(req);
    // Per-IP limit, counted in the table itself (no extra store): a report
    // form is a cheap way to flood the ops phone.
    if (ip) {
      const [{ n }] = await db
        .select({ n: count() })
        .from(adReports)
        .where(and(eq(adReports.ipAddress, ip), gt(adReports.createdAt, new Date(Date.now() - 3600_000))));
      if (n >= REPORTS_PER_IP_PER_HOUR) return reply.code(429).send({ error: "too_many_reports" });
    }
    const c = await findByPublicId(body.ad);
    if (!c) return reply.code(404).send({ error: "not_found" });
    if (c.complianceStatus === "taken_down") return reply.code(409).send({ error: "ad_removed" });

    const [row] = await db
      .insert(adReports)
      .values({
        campaignId: c.id,
        reason: body.reason,
        details: body.details || null,
        reporterEmail: body.email || null,
        ipAddress: ip,
        userAgent: clientUserAgent(req),
      })
      .returning({ id: adReports.id });
    await notifyOps({
      title: `AdVault: ad reported (${body.reason.replaceAll("_", " ")})`,
      message: `"${c.name}" by ${c.businessName} was reported.${body.details ? `\n${body.details.slice(0, 300)}` : ""}\nReview: /dashboard/admin/reports`,
      priority: body.reason === "scam_or_fraud" ? 4 : 3,
      tags: ["triangular_flag_on_post"],
    }).catch(() => false);
    return reply.code(201).send({ id: row!.id });
  });

  // ---- admin ----

  app.register(async (admin) => {
    admin.addHook("onRequest", requireAuth);
    admin.addHook("preHandler", requireAdmin);
    admin.addHook("preHandler", requireRealAdmin);

    admin.get(
      "/admin/reports",
      { schema: { querystring: z.object({ status: z.enum(["open", "dismissed", "actioned"]).optional() }) } },
      async (req) => {
        const status = (req.query as { status?: "open" | "dismissed" | "actioned" }).status ?? "open";
        const rows = await db
          .select({
            id: adReports.id,
            reason: adReports.reason,
            details: adReports.details,
            reporterEmail: adReports.reporterEmail,
            status: adReports.status,
            createdAt: adReports.createdAt,
            handledAt: adReports.handledAt,
            campaignId: campaigns.id,
            publicId: campaigns.publicId,
            campaignName: campaigns.name,
            businessName: campaigns.businessName,
            campaignStatus: campaigns.status,
            complianceStatus: campaigns.complianceStatus,
            landingUrl: campaigns.landingUrl,
            ownerEmail: users.email,
          })
          .from(adReports)
          .leftJoin(campaigns, eq(adReports.campaignId, campaigns.id))
          .leftJoin(users, eq(users.id, campaigns.userId))
          .where(eq(adReports.status, status))
          .orderBy(status === "open" ? adReports.createdAt : desc(adReports.handledAt))
          .limit(200);
        return { status, reports: rows };
      },
    );

    admin.post(
      "/admin/reports/:reportId/dismiss",
      { schema: { params: z.object({ reportId: z.string().uuid() }) } },
      async (req, reply) => {
        const { reportId } = req.params as { reportId: string };
        const [row] = await db
          .update(adReports)
          .set({ status: "dismissed", handledBy: req.userId!, handledAt: new Date() })
          .where(and(eq(adReports.id, reportId), eq(adReports.status, "open")))
          .returning();
        if (!row) return reply.code(409).send({ error: "not_open" });
        return row;
      },
    );

    admin.post(
      "/admin/campaigns/:campaignId/takedown",
      {
        schema: {
          params: z.object({ campaignId: z.string().uuid() }),
          body: z.object({ reason: z.string().trim().min(3).max(1000) }),
        },
      },
      async (req, reply) => {
        const { campaignId } = req.params as { campaignId: string };
        const [c] = await db
          .select({ complianceStatus: campaigns.complianceStatus })
          .from(campaigns)
          .where(eq(campaigns.id, campaignId))
          .limit(1);
        if (!c) return reply.code(404).send({ error: "not_found" });
        if (c.complianceStatus === "taken_down") return reply.code(409).send({ error: "already_taken_down" });
        const result = await takeDownCampaign({
          campaignId,
          adminId: req.userId!,
          reason: (req.body as { reason: string }).reason,
        });
        req.log.warn({ campaignId, admin: req.userId, result }, "ad taken down");
        return { takenDown: true, ...result };
      },
    );

    admin.get("/admin/compliance", async () => {
      const rows = await db
        .select({
          campaignId: campaigns.id,
          name: campaigns.name,
          businessName: campaigns.businessName,
          businessCategory: campaigns.businessCategory,
          offerDetails: campaigns.offerDetails,
          status: campaigns.status,
          complianceStatus: campaigns.complianceStatus,
          complianceReasons: campaigns.complianceReasons,
          takenDownAt: campaigns.takenDownAt,
          takenDownReason: campaigns.takenDownReason,
          updatedAt: campaigns.updatedAt,
          ownerEmail: users.email,
        })
        .from(campaigns)
        .innerJoin(users, eq(users.id, campaigns.userId))
        .where(inArray(campaigns.complianceStatus, ["needs_review", "taken_down"]))
        .orderBy(desc(campaigns.updatedAt))
        .limit(200);
      return {
        needsReview: rows.filter((r) => r.complianceStatus === "needs_review"),
        takenDown: rows.filter((r) => r.complianceStatus === "taken_down"),
      };
    });

    admin.post(
      "/admin/compliance/:campaignId/approve",
      { schema: { params: z.object({ campaignId: z.string().uuid() }) } },
      async (req, reply) => {
        const { campaignId } = req.params as { campaignId: string };
        const [c] = await db
          .select({ complianceStatus: campaigns.complianceStatus, complianceReasons: campaigns.complianceReasons })
          .from(campaigns)
          .where(eq(campaigns.id, campaignId))
          .limit(1);
        if (!c) return reply.code(404).send({ error: "not_found" });
        if (c.complianceStatus !== "needs_review") return reply.code(409).send({ error: "not_needs_review" });
        // Conditional on still needing review: an edit or takedown in between wins.
        const [updated] = await db
          .update(campaigns)
          .set({
            complianceStatus: "ok",
            complianceReasons: approveAll(c.complianceReasons ?? null),
            complianceReviewedBy: req.userId!,
            complianceReviewedAt: new Date(),
          })
          .where(and(eq(campaigns.id, campaignId), eq(campaigns.complianceStatus, "needs_review")))
          .returning({ id: campaigns.id, complianceStatus: campaigns.complianceStatus, complianceReasons: campaigns.complianceReasons });
        if (!updated) return reply.code(409).send({ error: "not_needs_review" });
        req.log.info({ campaignId, admin: req.userId }, "ad wording approved");
        return updated;
      },
    );
  });
}

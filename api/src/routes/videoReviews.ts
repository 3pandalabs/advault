import { and, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAdminOrAnalyticsToken } from "../auth/adminAccess.js";
import { db } from "../db/index.js";
import { campaigns, creatives, users } from "../db/schema.js";
import { REJECT_REASON_MAX, reviewTransition, type ReviewStatus } from "../lib/uploads/review.js";
import { presignDownload } from "../plugins/r2.js";
import { enqueueYoutubeUpload } from "../render/youtubeJobs.js";

// The admin review queue for customer-uploaded videos (see routes/uploads.ts
// and lib/uploads/review.ts). Admin session or ADMIN_ANALYTICS_TOKEN, the same
// gate as /admin/metrics. A token caller has no user, so its decisions record
// reviewed_by NULL.
//
// Approval is the only thing that publishes a customer upload to YouTube.

const listQuery = z.object({
  status: z.enum(["pending_review", "approved", "rejected"]).optional(),
});

const decisionBody = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("approve") }),
  z.object({ decision: z.literal("reject"), reason: z.string().max(REJECT_REASON_MAX * 2) }),
]);

export async function videoReviewRoutes(app: FastifyInstance) {
  app.get(
    "/admin/video-reviews",
    { preHandler: requireAdminOrAnalyticsToken, schema: { querystring: listQuery } },
    async (req) => {
      const status = (req.query as z.infer<typeof listQuery>).status ?? "pending_review";
      const rows = await db
        .select({
          creativeId: creatives.id,
          campaignId: campaigns.id,
          campaignName: campaigns.name,
          businessName: campaigns.businessName,
          landingUrl: campaigns.landingUrl,
          campaignStatus: campaigns.status,
          ownerEmail: users.email,
          aspectRatio: creatives.aspectRatio,
          durationSeconds: creatives.durationSeconds,
          sizeBytes: creatives.sizeBytes,
          videoKey: creatives.videoKey,
          reviewStatus: creatives.reviewStatus,
          reviewedAt: creatives.reviewedAt,
          reviewReason: creatives.reviewReason,
          rightsAttestedAt: creatives.rightsAttestedAt,
          rightsAttestedBy: creatives.rightsAttestedBy,
          createdAt: creatives.createdAt,
        })
        .from(creatives)
        .innerJoin(campaigns, eq(creatives.campaignId, campaigns.id))
        .innerJoin(users, eq(users.id, campaigns.userId))
        .where(and(eq(creatives.kind, "upload"), eq(creatives.reviewStatus, status)))
        // Oldest first for the queue; newest first for the decided lists.
        .orderBy(status === "pending_review" ? creatives.createdAt : desc(creatives.reviewedAt))
        .limit(100);

      // Ten-minute playback links, so the reviewer watches the exact bytes
      // that would be published.
      const videos = await Promise.all(
        rows.map(async ({ videoKey, ...r }) => ({
          ...r,
          videoUrl: videoKey ? await presignDownload(videoKey) : null,
        })),
      );
      return { status, videos };
    },
  );

  app.post(
    "/admin/video-reviews/:creativeId",
    {
      preHandler: requireAdminOrAnalyticsToken,
      schema: { params: z.object({ creativeId: z.string().uuid() }), body: decisionBody },
    },
    async (req, reply) => {
      const { creativeId } = req.params as { creativeId: string };
      const input = req.body as z.infer<typeof decisionBody>;

      const [creative] = await db
        .select({ id: creatives.id, reviewStatus: creatives.reviewStatus })
        .from(creatives)
        .where(eq(creatives.id, creativeId))
        .limit(1);
      if (!creative) return reply.code(404).send({ error: "not_found" });

      const t = reviewTransition((creative.reviewStatus ?? null) as ReviewStatus | null, input);
      if (!t.ok) return reply.code(t.error === "reason_required" ? 400 : 409).send({ error: t.error });

      // Conditional on still being pending, so two admins deciding at once
      // cannot both win (and approval cannot queue two YouTube uploads).
      const [updated] = await db
        .update(creatives)
        .set({
          reviewStatus: t.next,
          reviewReason: t.reason,
          reviewedBy: req.userRole === "admin" ? req.userId! : null,
          reviewedAt: new Date(),
        })
        .where(and(eq(creatives.id, creativeId), eq(creatives.reviewStatus, "pending_review")))
        .returning();
      if (!updated) return reply.code(409).send({ error: "already_reviewed" });

      if (t.next === "approved") await enqueueYoutubeUpload(creativeId);

      req.log.info({ creativeId, decision: t.next, reviewer: req.userId ?? "token" }, "video reviewed");
      return updated;
    },
  );
}

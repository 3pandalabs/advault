import { desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../auth/plugin.js";
import { db } from "../db/index.js";
import { campaigns, creatives } from "../db/schema.js";
import { loadOwnedCampaign } from "../lib/ownership.js";

// US ZIPs, 5 digits. Validated here as well as by the CHECK constraint so the
// wizard gets a field-level error instead of a 400 with no shape to it.
const zipCode = z.string().regex(/^\d{5}$/, "must be a 5-digit ZIP code");

const campaignInput = z.object({
  name: z.string().min(1).max(120),
  businessName: z.string().min(1).max(160),
  businessCategory: z.string().min(1).max(80),
  callToAction: z.string().min(1).max(40).default("Call now"),
  // Constrained to http(s) so a campaign can't ship a javascript: or data:
  // landing URL into a live ad.
  landingUrl: z.string().url().max(500).refine((u) => /^https?:\/\//i.test(u), {
    message: "must be an http(s) URL",
  }),
  offerDetails: z.string().max(2000).nullish(),
  targetZipCodes: z.array(zipCode).min(1).max(50),
  radiusMiles: z.number().int().min(1).max(50).default(10),
  // Minor units. A $5/day floor because Google's own minimums and this app's
  // per-impression maths both stop being meaningful below it; the $500/day
  // ceiling is a guardrail against a mistyped budget, not a product limit.
  dailyBudgetCents: z.number().int().min(500).max(50_000),
  currencyCode: z.string().length(3).default("USD"),
});

export async function campaignRoutes(app: FastifyInstance) {
  app.addHook("onRequest", requireAuth);

  app.post("/campaigns", { schema: { body: campaignInput } }, async (req, reply) => {
    const body = req.body as z.infer<typeof campaignInput>;
    const [campaign] = await db
      .insert(campaigns)
      .values({ ...body, userId: req.userId! })
      .returning();
    return reply.code(201).send(campaign);
  });

  app.get("/campaigns", async (req) => {
    return db
      .select()
      .from(campaigns)
      .where(eq(campaigns.userId, req.userId!))
      .orderBy(desc(campaigns.createdAt));
  });

  app.get(
    "/campaigns/:campaignId",
    { schema: { params: z.object({ campaignId: z.string().uuid() }) } },
    async (req, reply) => {
      const { campaignId } = req.params as { campaignId: string };
      const campaign = await loadOwnedCampaign(campaignId, req.userId!, reply);
      if (!campaign) return;

      const rows = await db
        .select()
        .from(creatives)
        .where(eq(creatives.campaignId, campaignId))
        .orderBy(desc(creatives.createdAt));

      return { ...campaign, creatives: rows };
    },
  );

  app.patch(
    "/campaigns/:campaignId",
    {
      schema: {
        params: z.object({ campaignId: z.string().uuid() }),
        body: campaignInput.partial(),
      },
    },
    async (req, reply) => {
      const { campaignId } = req.params as { campaignId: string };
      const campaign = await loadOwnedCampaign(campaignId, req.userId!, reply);
      if (!campaign) return;

      // Editing a live campaign here would silently diverge from what is
      // actually serving at Google — the budget in this table would say one
      // thing and the advertiser's card would be charged another. Changes to a
      // live campaign belong in Google Ads until this app can push updates.
      if (campaign.status === "live") {
        return reply.code(409).send({ error: "campaign_is_live" });
      }

      const [updated] = await db
        .update(campaigns)
        .set({ ...(req.body as object), updatedAt: new Date() })
        .where(eq(campaigns.id, campaignId))
        .returning();
      return updated;
    },
  );

  app.delete(
    "/campaigns/:campaignId",
    { schema: { params: z.object({ campaignId: z.string().uuid() }) } },
    async (req, reply) => {
      const { campaignId } = req.params as { campaignId: string };
      const campaign = await loadOwnedCampaign(campaignId, req.userId!, reply);
      if (!campaign) return;

      // Deleting the local row would not stop a live campaign from spending —
      // it would just remove the only place the advertiser can see it. Pause
      // at Google first.
      if (campaign.status === "live") {
        return reply.code(409).send({ error: "campaign_is_live" });
      }

      await db.delete(campaigns).where(eq(campaigns.id, campaignId));
      return reply.code(204).send();
    },
  );
}

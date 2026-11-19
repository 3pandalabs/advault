import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../auth/plugin.js";
import { db } from "../db/index.js";
import { assets, campaigns } from "../db/schema.js";
import { loadOwnedCampaign } from "../lib/ownership.js";
import { categoryKey } from "../lib/categories/key.js";
import { EXTRAS_DETAIL, extrasFor, extrasProblem, type CategoryExtras } from "../lib/categories/extras.js";

// Category extras (2026-11-20, migration 0040, lib/categories/extras): a
// restaurant's featured dish and order link, an auto shop's makes, a
// landscaper's existing-customer ZIPs. They go into the NEXT ad made; saving
// never re-renders and never touches Google. Pointing the ad's ZIPs or link
// at them is a separate, explicit PATCH /campaigns/:id (before launch).

const params = z.object({ campaignId: z.string().uuid() });

export const categoryExtrasSchema = z
  .object({
    spotlight: z
      .object({
        dish: z.string().max(80),
        price: z.string().max(40).nullish(),
        assetId: z.string().uuid().nullish(),
      })
      .strict()
      .nullish(),
    orderUrl: z.string().max(500).nullish(),
    makes: z.array(z.string().max(40)).max(30).nullish(),
    neighborZips: z.array(z.string().max(10)).max(100).nullish(),
  })
  .strict();

/** Trimmed, with empty values dropped (an empty field means "none"). */
function clean(e: z.infer<typeof categoryExtrasSchema>): CategoryExtras {
  const out: CategoryExtras = {};
  if (e.spotlight && (e.spotlight.dish.trim() || e.spotlight.price?.trim() || e.spotlight.assetId)) {
    out.spotlight = {
      dish: e.spotlight.dish.trim(),
      price: e.spotlight.price?.trim() || null,
      assetId: e.spotlight.assetId ?? null,
    };
  }
  if (e.orderUrl?.trim()) out.orderUrl = e.orderUrl.trim();
  const makes = [...new Set((e.makes ?? []).map((m) => m.trim()).filter(Boolean))];
  if (makes.length) out.makes = makes;
  const zips = [...new Set((e.neighborZips ?? []).map((z) => z.trim()).filter(Boolean))];
  if (zips.length) out.neighborZips = zips;
  return out;
}

export async function categoryExtrasRoutes(app: FastifyInstance) {
  app.addHook("onRequest", requireAuth);

  app.get("/campaigns/:campaignId/extras", { schema: { params } }, async (req, reply) => {
    const { campaignId } = req.params as { campaignId: string };
    const campaign = await loadOwnedCampaign(campaignId, req.userId!, reply);
    if (!campaign) return;
    return { available: extrasFor(categoryKey(campaign.businessCategory)), extras: campaign.categoryExtras ?? {} };
  });

  app.put("/campaigns/:campaignId/extras", { schema: { params, body: categoryExtrasSchema } }, async (req, reply) => {
    const { campaignId } = req.params as { campaignId: string };
    const campaign = await loadOwnedCampaign(campaignId, req.userId!, reply);
    if (!campaign) return;
    const extras = clean(req.body as z.infer<typeof categoryExtrasSchema>);
    const key = categoryKey(campaign.businessCategory);
    const problem = extrasProblem(key, extras);
    if (problem) return reply.code(400).send({ error: problem, detail: EXTRAS_DETAIL[problem] });

    // The dish photo must be the advertiser's own (it leads their ad).
    const photo = extras.spotlight?.assetId;
    if (photo) {
      const [own] = await db
        .select({ id: assets.id })
        .from(assets)
        .where(and(eq(assets.id, photo), eq(assets.userId, req.userId!), eq(assets.kind, "photo")))
        .limit(1);
      if (!own) return reply.code(400).send({ error: "unknown_assets" });
    }

    const empty = Object.keys(extras).length === 0;
    const [updated] = await db
      .update(campaigns)
      .set({ categoryExtras: empty ? null : extras, updatedAt: new Date() })
      .where(eq(campaigns.id, campaign.id))
      .returning();
    return { available: extrasFor(key), extras: updated!.categoryExtras ?? {} };
  });
}

import { and, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../auth/plugin.js";
import { db } from "../db/index.js";
import { assets, purchases, users } from "../db/schema.js";
import { loadOwnedCampaign } from "../lib/ownership.js";
import { formatMinor } from "../lib/pricing/index.js";
import { providerFor } from "../lib/payments/index.js";
import { createPurchase, markDelivered, quoteFor } from "../lib/cinematic/index.js";
import { generateForCampaign } from "../lib/creatives/generate.js";
import {
  campaignHasPaidAd,
  claimNewAdOrder,
  paysPerAd,
  releaseNewAdOrder,
  type NewAdBrief,
} from "../lib/newAd/index.js";

const WEB_ORIGIN = process.env.WEB_ORIGIN ?? "https://advault.3pandalabs.com";

// The $19 new ad (Keep it running). See lib/newAd for the lifecycle. The
// payment webhook is the shared /webhooks/purchases/:provider in cinematic.ts,
// which marks any purchase paid whatever its sku.
export async function newAdRoutes(app: FastifyInstance) {
  app.addHook("onRequest", requireAuth);

  // What the wizard and campaign page need: does this user pay per ad, what
  // does it cost, and the campaign's latest order if any.
  app.get(
    "/campaigns/:campaignId/new-ad",
    { schema: { params: z.object({ campaignId: z.string().uuid() }) } },
    async (req, reply) => {
      const { campaignId } = req.params as { campaignId: string };
      const campaign = await loadOwnedCampaign(campaignId, req.userId!, reply);
      if (!campaign) return;
      return newAdStatus(req.userId!, campaign.id);
    },
  );

  // Price check before a campaign exists (wizard step 3 button label).
  app.get("/new-ad/quote", async (req) => {
    if (!(await paysPerAd(req.userId!))) return { required: false };
    const quote = await quoteFor(req.userId!, "new_ad");
    return {
      required: true,
      amountMinor: quote.amountMinor,
      currency: quote.currency,
      display: formatMinor(quote.amountMinor, quote.currency),
    };
  });

  app.post(
    "/campaigns/:campaignId/new-ad/order",
    {
      schema: {
        params: z.object({ campaignId: z.string().uuid() }),
        // Optional: omitted means "same photos and formats as my last order
        // for this campaign", for retrying an abandoned checkout.
        body: z
          .object({
            assetIds: z.array(z.string().uuid()).min(1).max(5),
            aspectRatios: z.array(z.enum(["16:9", "9:16"])).min(1).max(2).default(["16:9", "9:16"]),
          })
          .optional(),
      },
    },
    async (req, reply) => {
      const { campaignId } = req.params as { campaignId: string };
      let brief = req.body as NewAdBrief | undefined;
      const campaign = await loadOwnedCampaign(campaignId, req.userId!, reply);
      if (!campaign) return;
      if (campaign.status === "live") return reply.code(409).send({ error: "campaign_is_live" });
      if (!(await paysPerAd(req.userId!))) return reply.code(409).send({ error: "ad_included_in_plan" });
      if (await campaignHasPaidAd(campaign.id)) return reply.code(409).send({ error: "already_paid" });
      if (!brief) {
        const [last] = await db
          .select({ brief: purchases.brief })
          .from(purchases)
          .where(and(eq(purchases.campaignId, campaign.id), eq(purchases.sku, "new_ad")))
          .orderBy(desc(purchases.createdAt))
          .limit(1);
        brief = (last?.brief as NewAdBrief | null) ?? undefined;
        if (!brief) return reply.code(400).send({ error: "choose_photos" });
      }
      const chosen = brief;

      // Checked now, not at generation: a payment for photos that are not
      // theirs would be money taken for an ad that can never be made.
      const owned = await db
        .select({ id: assets.id })
        .from(assets)
        .where(eq(assets.userId, req.userId!));
      const ownedIds = new Set(owned.map((a) => a.id));
      if (!chosen.assetIds.every((id) => ownedIds.has(id))) {
        return reply.code(400).send({ error: "unknown_assets" });
      }

      const quote = await quoteFor(req.userId!, "new_ad");
      const provider = providerFor(quote.currency);
      const purchase = await createPurchase({
        userId: req.userId!,
        campaignId: campaign.id,
        addOnKey: quote.addOn.key,
        amountMinor: quote.amountMinor,
        provider: provider.name,
      });
      await db
        .update(purchases)
        .set({ brief: chosen, updatedAt: new Date() })
        .where(eq(purchases.id, purchase.id));

      const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, req.userId!)).limit(1);
      const session = await provider.createCheckout({
        paymentId: purchase.id,
        amountMinor: quote.amountMinor,
        currency: quote.currency,
        purpose: "add_on",
        userEmail: user?.email ?? "",
        returnUrl: `${WEB_ORIGIN}/dashboard/campaigns/${campaign.id}`,
      });
      await db
        .update(purchases)
        .set({ providerRef: session.providerRef, updatedAt: new Date() })
        .where(eq(purchases.id, purchase.id));

      return reply.code(201).send({
        purchaseId: purchase.id,
        checkout: { provider: provider.name, redirectUrl: session.redirectUrl, clientPayload: session.clientPayload },
      });
    },
  );

  // Spend a paid order: write the scripts and queue the renders from the
  // choices saved on it. Called by the campaign page once payment lands.
  app.post(
    "/new-ad/orders/:purchaseId/generate",
    { schema: { params: z.object({ purchaseId: z.string().uuid() }) } },
    async (req, reply) => {
      const { purchaseId } = req.params as { purchaseId: string };
      const [order] = await db
        .select()
        .from(purchases)
        .where(and(eq(purchases.id, purchaseId), eq(purchases.userId, req.userId!), eq(purchases.sku, "new_ad")))
        .limit(1);
      if (!order || !order.campaignId) return reply.code(404).send({ error: "not_found" });
      if (order.status === "delivered") return reply.code(200).send({ alreadyGenerated: true });
      if (order.status === "pending") return reply.code(409).send({ error: "payment_pending" });

      const campaign = await loadOwnedCampaign(order.campaignId, req.userId!, reply);
      if (!campaign) return;

      const claimed = await claimNewAdOrder(order.id);
      if (!claimed) return reply.code(409).send({ error: "in_progress" });

      const brief = order.brief as NewAdBrief;
      try {
        const result = await generateForCampaign({
          campaign,
          userId: req.userId!,
          assetIds: brief.assetIds,
          aspectRatios: brief.aspectRatios,
          warn: (msg, err) => req.log.warn({ err, purchaseId }, msg),
        });
        if (!result.ok) {
          await releaseNewAdOrder(order.id, result.body.error);
          return reply.code(result.status).send(result.body);
        }
        await markDelivered(order.id);
        return reply.code(202).send({ creatives: result.creatives });
      } catch (err) {
        await releaseNewAdOrder(order.id, err);
        throw err;
      }
    },
  );
}

async function newAdStatus(userId: string, campaignId: string) {
  const required = await paysPerAd(userId);
  const [order] = await db
    .select({ id: purchases.id, status: purchases.status, amountMinor: purchases.amountMinor, currency: purchases.currencyCode })
    .from(purchases)
    .where(and(eq(purchases.campaignId, campaignId), eq(purchases.sku, "new_ad")))
    .orderBy(desc(purchases.createdAt))
    .limit(1);
  const quote = required ? await quoteFor(userId, "new_ad") : null;
  return {
    required,
    display: quote ? formatMinor(quote.amountMinor, quote.currency) : null,
    order: order ?? null,
  };
}

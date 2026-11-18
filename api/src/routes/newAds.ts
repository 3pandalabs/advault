import { and, desc, eq, ne, notInArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../auth/plugin.js";
import { db } from "../db/index.js";
import { assets, creatives, purchases, users } from "../db/schema.js";
import { deleteObject } from "../plugins/r2.js";
import { loadOwnedCampaign } from "../lib/ownership.js";
import { SITE_OFFER_ADDON, chargeMinor, formatMinor } from "../lib/pricing/index.js";
import { pushSiteOffer, quoteCampaignSiteOffer, recordSiteOffer } from "../lib/siteOffer/index.js";
import { providerFor } from "../lib/payments/index.js";
import { createPurchase, markDelivered, markPurchasePaid } from "../lib/cinematic/index.js";
import { generateForCampaign } from "../lib/creatives/generate.js";
import {
  campaignHasPaidAd,
  claimNewAdOrder,
  paysPerAd,
  quoteNewAd,
  RENDERS_PER_AD,
  releaseNewAdOrder,
  type NewAdBrief,
} from "../lib/newAd/index.js";

const WEB_ORIGIN = process.env.WEB_ORIGIN ?? "https://advault.3pandalabs.com";

// The $10 new ad (Keep it running). See lib/newAd for the lifecycle. The
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
      return newAdStatus(req.userId!, campaign);
    },
  );

  // Price check before a campaign exists (wizard step 3 button label).
  app.get("/new-ad/quote", async (req) => {
    if (!(await paysPerAd(req.userId!))) return { required: false };
    const quote = await quoteNewAd(req.userId!);
    return {
      required: true,
      amountMinor: quote.amountMinor,
      currency: quote.currency,
      display: formatMinor(quote.amountMinor, quote.currency),
      freeLaunchOffer: quote.freeLaunchOffer,
    };
  });

  app.post(
    "/campaigns/:campaignId/new-ad/order",
    {
      schema: {
        params: z.object({ campaignId: z.string().uuid() }),
        // Photos optional: omitted means "same photos and formats as my last
        // order for this campaign", for retrying an abandoned checkout.
        // siteOffer: "Also put this offer on my website" (offer combo).
        body: z
          .object({
            assetIds: z.array(z.string().uuid()).min(1).max(5).optional(),
            peopleAssetIds: z.array(z.string().uuid()).max(5).optional(),
            portraitAssetId: z.string().uuid().nullish(),
            aspectRatios: z.array(z.enum(["16:9", "9:16"])).min(1).max(2).default(["16:9", "9:16"]),
            siteOffer: z.boolean().optional(),
          })
          .optional(),
      },
    },
    async (req, reply) => {
      const { campaignId } = req.params as { campaignId: string };
      const input = req.body as (Partial<NewAdBrief> & { siteOffer?: boolean }) | undefined;
      let brief: NewAdBrief | undefined = input?.assetIds
        ? {
            assetIds: input.assetIds,
            aspectRatios: input.aspectRatios ?? ["16:9", "9:16"],
            peopleAssetIds: input.peopleAssetIds,
            portraitAssetId: input.portraitAssetId,
          }
        : undefined;
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

      const quote = await quoteNewAd(req.userId!);
      // Offer combo, decided now from SiteVault's live answer. Unreachable
      // SiteVault (or a paused site, no offer text…) refuses the option
      // rather than guessing a price; the customer can untick and retry.
      const site = input?.siteOffer
        ? await quoteCampaignSiteOffer({ campaign, exempt: false, currency: quote.currency, ticked: true, testMode: quote.testMode })
        : null;
      if (site && (!site.available || !site.mode || !site.slug)) {
        return reply.code(409).send({ error: "site_offer_unavailable" });
      }
      const addonMinor = site?.addonMinor ?? 0;
      const totalMinor = quote.amountMinor + addonMinor;
      // A free ad (launch offer) skips checkout: there is nothing to charge.
      // It is marked paid at once, which writes no ledger rows for $0.
      const provider = totalMinor === 0 ? null : providerFor(quote.currency);
      const purchase = await createPurchase({
        userId: req.userId!,
        campaignId: campaign.id,
        addOnKey: quote.addOn.key,
        amountMinor: totalMinor,
        provider: provider?.name ?? "manual",
      });
      await db
        .update(purchases)
        .set({ brief: chosen, updatedAt: new Date() })
        .where(eq(purchases.id, purchase.id));
      if (site?.mode && site.slug) await recordSiteOffer(purchase.id, site.mode, site.offer, site.slug);

      if (!provider) {
        await markPurchasePaid({ purchaseId: purchase.id, externalRef: `launch-offer:${purchase.id}` });
        if (site?.mode) await pushSiteOffer(purchase.id);
        return reply.code(201).send({
          purchaseId: purchase.id,
          freeLaunchOffer: true,
          checkout: { provider: "none", redirectUrl: null, clientPayload: {} },
        });
      }

      const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, req.userId!)).limit(1);
      const session = await provider.createCheckout({
        paymentId: purchase.id,
        amountMinor: totalMinor,
        currency: quote.currency,
        purpose: "add_on",
        testMode: quote.testMode,
        internal: quote.internal,
        internalLabel: quote.internalLabel,
        lineItems:
          addonMinor > 0
            ? [
                { amountMinor: quote.amountMinor, name: "AdVault new ad" },
                { amountMinor: addonMinor, name: SITE_OFFER_ADDON[quote.currency]?.label ?? "Offer on your website" },
              ]
            : undefined,
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

  // Offer combo for admins and at_cost accounts: they never buy a new ad, so
  // the website offer is pushed free on request, recorded as its own $0
  // 'site_offer' purchase row so the campaign page and the retry sweep treat
  // it like a paid one.
  app.post(
    "/campaigns/:campaignId/site-offer",
    { schema: { params: z.object({ campaignId: z.string().uuid() }) } },
    async (req, reply) => {
      const { campaignId } = req.params as { campaignId: string };
      const campaign = await loadOwnedCampaign(campaignId, req.userId!, reply);
      if (!campaign) return;
      if (await paysPerAd(req.userId!)) return reply.code(402).send({ error: "buy_with_new_ad" });
      const quote = await quoteNewAd(req.userId!);
      const site = await quoteCampaignSiteOffer({ campaign, exempt: true, currency: quote.currency, ticked: true });
      if (!site.available || !site.mode || !site.slug) return reply.code(409).send({ error: "site_offer_unavailable" });
      const [row] = await db
        .insert(purchases)
        .values({
          userId: req.userId!,
          campaignId: campaign.id,
          addOnKey: "site_offer",
          sku: "site_offer",
          currencyCode: quote.currency,
          amountMinor: 0,
          provider: "manual",
          // 'delivered', not 'paid': nothing is produced, and /metrics counts
          // 'paid' purchases as awaiting production.
          status: "delivered",
          paidAt: new Date(),
          deliveredAt: new Date(),
          siteOfferMode: site.mode,
          siteOfferText: site.offer,
          siteOfferSlug: site.slug,
        })
        .returning({ id: purchases.id });
      const result = await pushSiteOffer(row!.id);
      return reply.code(201).send({ purchaseId: row!.id, pushed: result === "pushed" });
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
          peopleAssetIds: brief.peopleAssetIds,
          portraitAssetId: brief.portraitAssetId,
          aspectRatios: brief.aspectRatios,
          warn: (msg, err) => req.log.warn({ err, purchaseId }, msg),
        });
        if (!result.ok) {
          await releaseNewAdOrder(order.id, result.body.error);
          return reply.code(result.status).send(result.body);
        }
        await markDelivered(order.id);
        // The first of the order's RENDERS_PER_AD renders.
        await db.update(purchases).set({ rendersUsed: 1 }).where(eq(purchases.id, order.id));
        // A paid new version replaces the previous AdVault-made one (launch
        // uses every ready creative). Uploaded videos stay.
        const keep = result.creatives.map((c) => c.id);
        const old = await db
          .delete(creatives)
          .where(and(eq(creatives.campaignId, campaign.id), ne(creatives.kind, "upload"), notInArray(creatives.id, keep)))
          .returning({ videoKey: creatives.videoKey, thumbnailKey: creatives.thumbnailKey });
        await Promise.all(
          old.flatMap((o) => [o.videoKey, o.thumbnailKey]).filter((k): k is string => Boolean(k)).map((k) => deleteObject(k).catch(() => undefined)),
        );
        return reply.code(202).send({ creatives: result.creatives });
      } catch (err) {
        await releaseNewAdOrder(order.id, err);
        throw err;
      }
    },
  );
}

async function newAdStatus(userId: string, campaign: { id: string; landingUrl: string | null; offerDetails: string | null }) {
  const campaignId = campaign.id;
  const required = await paysPerAd(userId);
  const [order] = await db
    .select({ id: purchases.id, status: purchases.status, amountMinor: purchases.amountMinor, currency: purchases.currencyCode })
    .from(purchases)
    .where(and(eq(purchases.campaignId, campaignId), eq(purchases.sku, "new_ad")))
    .orderBy(desc(purchases.createdAt))
    .limit(1);
  const quote = required ? await quoteNewAd(userId) : null;
  // Redos left on the campaign's made ad (null = not metered: admin/at_cost).
  const [made] = required
    ? await db
        .select({ used: purchases.rendersUsed })
        .from(purchases)
        .where(and(eq(purchases.campaignId, campaignId), eq(purchases.sku, "new_ad"), eq(purchases.status, "delivered")))
        .orderBy(desc(purchases.createdAt))
        .limit(1)
    : [];
  // Offer combo: the "Also put this offer on my website" box, when SiteVault
  // answers. Exempt users get it free (POST /campaigns/:id/site-offer).
  const site = await quoteCampaignSiteOffer({
    campaign,
    exempt: !required,
    currency: quote?.currency ?? (await quoteNewAd(userId)).currency,
    ticked: false,
    testMode: quote?.testMode,
  });
  const addon = quote ? SITE_OFFER_ADDON[quote.currency] : undefined;
  const addonMinor = addon && quote ? chargeMinor(addon.priceMinor, quote.testMode) : null;
  return {
    siteOffer: site.available
      ? {
          offered: site.offered,
          offer: site.offer,
          credits: site.credits,
          addonDisplay: addonMinor !== null && quote ? formatMinor(addonMinor, quote.currency) : null,
        }
      : null,
    required,
    redosLeft: required ? (made ? Math.max(0, RENDERS_PER_AD - made.used) : 0) : null,
    display: quote ? formatMinor(quote.amountMinor, quote.currency) : null,
    freeLaunchOffer: quote?.freeLaunchOffer ?? false,
    order: order ?? null,
  };
}

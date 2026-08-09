import { and, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../auth/plugin.js";
import { db } from "../db/index.js";
import { purchases, users } from "../db/schema.js";
import { loadOwnedCampaign } from "../lib/ownership.js";
import {
  ADD_ONS,
  addOnByKey,
  formatMinor,
  isCurrency,
  type Currency,
} from "../lib/pricing/index.js";
import { providerByName, providerFor } from "../lib/payments/index.js";
import {
  createPurchase,
  markPurchasePaid,
  quoteFor,
  NoSuchAddOn,
} from "../lib/cinematic/index.js";
import { isCinematicConfigured } from "../lib/ai/cinematic/index.js";
import { REAL_PHOTO_CLOSE_SECONDS } from "../lib/cinematic/policy.js";

const WEB_ORIGIN = process.env.WEB_ORIGIN ?? "https://advault.3pandalabs.com";

function publicPurchase(row: typeof purchases.$inferSelect) {
  return {
    id: row.id,
    addOnKey: row.addOnKey,
    sku: row.sku,
    campaignId: row.campaignId,
    currency: row.currencyCode,
    amountMinor: row.amountMinor,
    display: { amount: formatMinor(row.amountMinor, row.currencyCode as Currency) },
    status: row.status,
    attempts: row.attempts,
    // lastError is deliberately included: when someone has paid and not
    // received an ad, hiding the reason from them is the wrong default.
    lastError: row.lastError,
    paidAt: row.paidAt,
    deliveredAt: row.deliveredAt,
    createdAt: row.createdAt,
  };
}

export async function cinematicRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------
  // Public: the add-on price card. Top of the funnel, no user data.
  // ---------------------------------------------------------------------
  app.get(
    "/add-ons",
    { schema: { querystring: z.object({ currency: z.string().default("USD") }) } },
    async (req, reply) => {
      const { currency } = req.query as { currency: string };
      if (!isCurrency(currency)) return reply.code(400).send({ error: "unsupported_currency" });

      return Object.values(ADD_ONS)
        .filter((a) => a.currency === currency)
        .map((a) => ({
          key: a.key,
          sku: a.sku,
          label: a.label,
          blurb: a.blurb,
          currency: a.currency,
          priceMinor: a.priceMinor,
          firstPurchasePriceMinor: a.firstPurchasePriceMinor,
          generatedSeconds: a.generatedSeconds,
          totalSeconds: a.generatedSeconds + REAL_PHOTO_CLOSE_SECONDS,
          display: {
            price: formatMinor(a.priceMinor, a.currency),
            firstPurchasePrice: formatMinor(a.firstPurchasePriceMinor, a.currency),
          },
          // Whether one could actually be produced right now. A price card
          // that offers something the deployment cannot make is worse than an
          // empty one — the customer pays and then waits for a refund.
          available: isCinematicConfigured(),
        }));
    },
  );

  // Everything below is the advertiser's own.
  app.register(async (scoped) => {
    scoped.addHook("onRequest", requireAuth);

    // -------------------------------------------------------------------
    // What THIS advertiser pays. Separate from /add-ons because the intro
    // price depends on their purchase history, which is not public data.
    // -------------------------------------------------------------------
    scoped.get("/cinematic/quote", async (req) => {
      const quote = await quoteFor(req.userId!, "cinematic");
      return {
        addOnKey: quote.addOn.key,
        currency: quote.currency,
        amountMinor: quote.amountMinor,
        listPriceMinor: quote.addOn.priceMinor,
        isFirstPurchase: quote.isFirstPurchase,
        generatedSeconds: quote.addOn.generatedSeconds,
        totalSeconds: quote.addOn.generatedSeconds + REAL_PHOTO_CLOSE_SECONDS,
        available: isCinematicConfigured(),
        display: {
          amount: formatMinor(quote.amountMinor, quote.currency),
          listPrice: formatMinor(quote.addOn.priceMinor, quote.currency),
        },
      };
    });

    scoped.post(
      "/cinematic/orders",
      {
        schema: {
          body: z.object({
            campaignId: z.string().uuid(),
            // What the advertiser wants to say, in their own words. The single
            // most valuable input to the whole product — the translation layer
            // turns it into cinematography, and it cannot invent what the
            // advertiser never said.
            description: z.string().min(20).max(2000),
            aspectRatio: z.enum(["16:9", "9:16"]).default("9:16"),
          }),
        },
      },
      async (req, reply) => {
        const body = req.body as {
          campaignId: string;
          description: string;
          aspectRatio: "16:9" | "9:16";
        };

        // Refuse BEFORE taking money rather than refunding after. There is no
        // degraded cinematic ad to fall back to — that is the entire product
        // distinction — so an unconfigured vendor means no sale, not a cheaper
        // one.
        if (!isCinematicConfigured()) {
          return reply.code(503).send({ error: "cinematic_unavailable" });
        }

        const campaign = await loadOwnedCampaign(body.campaignId, req.userId!, reply);
        if (!campaign) return;

        const quote = await quoteFor(req.userId!, "cinematic");
        const [user] = await db.select().from(users).where(eq(users.id, req.userId!)).limit(1);

        let purchase;
        try {
          purchase = await createPurchase({
            userId: req.userId!,
            campaignId: campaign.id,
            addOnKey: quote.addOn.key,
            amountMinor: quote.amountMinor,
            provider: providerFor(quote.currency).name,
          });
        } catch (err) {
          if (err instanceof NoSuchAddOn) {
            return reply.code(400).send({ error: "no_such_add_on" });
          }
          throw err;
        }

        // The description rides on the purchase rather than the campaign: two
        // orders for the same campaign are two different ads, and overwriting
        // the campaign would make the second one silently reuse the first's
        // brief.
        await db
          .update(purchases)
          .set({
            brief: { description: body.description, aspectRatio: body.aspectRatio },
            updatedAt: new Date(),
          })
          .where(eq(purchases.id, purchase.id));

        const provider = providerFor(quote.currency);
        const session = await provider.createCheckout({
          paymentId: purchase.id,
          amountMinor: quote.amountMinor,
          currency: quote.currency,
          purpose: "add_on",
          userEmail: user?.email ?? "",
          returnUrl: `${WEB_ORIGIN}/dashboard/cinematic/${purchase.id}`,
        });

        await db
          .update(purchases)
          .set({ providerRef: session.providerRef, updatedAt: new Date() })
          .where(eq(purchases.id, purchase.id));

        return reply.code(201).send({
          purchase: publicPurchase({ ...purchase, providerRef: session.providerRef }),
          checkout: {
            provider: provider.name,
            redirectUrl: session.redirectUrl,
            clientPayload: session.clientPayload,
          },
        });
      },
    );

    scoped.get("/cinematic/orders", async (req) => {
      const rows = await db
        .select()
        .from(purchases)
        .where(eq(purchases.userId, req.userId!))
        .orderBy(desc(purchases.createdAt));
      return rows.map(publicPurchase);
    });

    scoped.get(
      "/cinematic/orders/:purchaseId",
      { schema: { params: z.object({ purchaseId: z.string().uuid() }) } },
      async (req, reply) => {
        const { purchaseId } = req.params as { purchaseId: string };
        const [row] = await db
          .select()
          .from(purchases)
          .where(and(eq(purchases.id, purchaseId), eq(purchases.userId, req.userId!)))
          .limit(1);
        if (!row) return reply.code(404).send({ error: "not_found" });
        return publicPurchase(row);
      },
    );
  });

  // ---------------------------------------------------------------------
  // Webhook. Unauthenticated by necessity; the signature IS the auth.
  //
  // Separate from /webhooks/subscriptions because the id in provider metadata
  // means a different thing here — it is a purchase, not an invoice, and there
  // is no renewal indirection to resolve. Sharing the route would mean one
  // handler guessing which table an id belongs to.
  // ---------------------------------------------------------------------
  app.post(
    "/webhooks/purchases/:provider",
    {
      schema: { params: z.object({ provider: z.enum(["razorpay", "stripe"]) }) },
      config: { rawBody: true },
    },
    async (req, reply) => {
      const { provider: name } = req.params as { provider: string };
      const provider = providerByName(name);
      if (!provider) return reply.code(404).send({ error: "unknown_provider" });

      const raw = (req as { rawBody?: string }).rawBody;
      if (!raw) return reply.code(400).send({ error: "missing_raw_body" });

      const event = provider.verifyWebhook(raw, req.headers as Record<string, string | undefined>);
      if (!event) {
        req.log.warn({ provider: name }, "rejected an unverified purchase webhook");
        return reply.code(400).send({ error: "invalid_signature" });
      }

      const [purchase] = await db
        .select()
        .from(purchases)
        .where(eq(purchases.id, event.paymentId))
        .limit(1);
      if (!purchase) return reply.code(404).send({ error: "unknown_purchase" });

      if (event.status !== "paid") {
        await db
          .update(purchases)
          .set({
            status: event.status === "cancelled" ? "cancelled" : "pending",
            lastError: `payment ${event.status}`,
            updatedAt: new Date(),
          })
          .where(eq(purchases.id, purchase.id));
        return reply.code(200).send({ ok: true });
      }

      // A mismatch against what we quoted is not something to reconcile
      // silently — it means the price list and the provider's price object
      // have drifted, and the customer agreed to one of the two numbers.
      if (event.amountMinor !== purchase.amountMinor || event.currency !== purchase.currencyCode) {
        req.log.error(
          {
            purchaseId: purchase.id,
            expected: { amount: purchase.amountMinor, currency: purchase.currencyCode },
            received: { amount: event.amountMinor, currency: event.currency },
          },
          "purchase webhook amount did not match the quote",
        );
        return reply.code(409).send({ error: "amount_mismatch" });
      }

      const result = await markPurchasePaid({
        purchaseId: purchase.id,
        externalRef: `${provider.name}:${event.providerRef}`,
      });
      return reply.code(200).send({ ok: true, alreadyApplied: result.alreadyApplied });
    },
  );
}

import { and, desc, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../auth/plugin.js";
import { db } from "../db/index.js";
import { offerCycles } from "../db/schema.js";
import {
  applyInboundReply,
  approveCycle,
  ensureCycleForMonth,
  recordOffer,
  sendPreview,
} from "../lib/offers/index.js";
import { inferOfferExpiry } from "../lib/offers/policy.js";
import { liveSubscriptionFor } from "../lib/subscriptions/index.js";
import {
  isWhatsAppConfigured,
  parseInbound,
  verifyChallenge,
  verifyWebhookSignature,
} from "../lib/whatsapp/index.js";

export async function offerRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------
  // Meta's subscribe handshake. Called once, when the webhook is registered.
  // ---------------------------------------------------------------------
  app.get("/webhooks/whatsapp", async (req, reply) => {
    const challenge = verifyChallenge(req.query as Record<string, unknown>);
    if (challenge === null) return reply.code(403).send({ error: "verification_failed" });
    // Meta expects the raw challenge string, not JSON.
    return reply.type("text/plain").send(challenge);
  });

  // ---------------------------------------------------------------------
  // Inbound messages.
  //
  // ALWAYS answers 200 once the signature holds, even when nothing could be
  // done with the message. Meta redelivers on any non-2xx, so a 4xx for an
  // unrecognised sender turns into a redelivery loop that eventually throttles
  // the number — the replay guard is the provider-ref index, not the status
  // code.
  // ---------------------------------------------------------------------
  app.post(
    "/webhooks/whatsapp",
    { config: { rawBody: true } },
    async (req, reply) => {
      const raw = (req as { rawBody?: string }).rawBody;
      if (!raw) return reply.code(400).send({ error: "missing_raw_body" });

      if (!verifyWebhookSignature(raw, req.headers as Record<string, string | undefined>)) {
        req.log.warn("rejected an unverified WhatsApp webhook");
        // An unverified inbound message is an attacker choosing the text of an
        // advertisement and approving it. 400, and nothing else.
        return reply.code(400).send({ error: "invalid_signature" });
      }

      const messages = parseInbound(raw);
      const outcomes = [];
      for (const msg of messages) {
        try {
          const outcome = await applyInboundReply({
            phone: msg.from,
            body: msg.body,
            providerRef: msg.providerRef,
          });
          outcomes.push(outcome);

          // An offer needs a preview before it can be approved. Sent inline
          // because the creative render is queued, not awaited — the preview
          // says what we understood, which is the part worth confirming fast.
          if (outcome.handled && outcome.action === "offer_recorded") {
            await sendPreview(outcome.cycleId);
          }
        } catch (err) {
          // One bad message must not fail the batch: Meta would redeliver all
          // of them, including the ones already applied.
          req.log.error({ err, providerRef: msg.providerRef }, "inbound WhatsApp handling failed");
        }
      }

      return reply.code(200).send({ ok: true, handled: outcomes.length });
    },
  );

  // ---------------------------------------------------------------------
  // Dashboard fallback.
  //
  // WhatsApp is the primary interface, but it is not the only one: some owners
  // prefer a screen, some have no WhatsApp on the number they gave us, and the
  // channel can be unavailable. Every step of the loop therefore has an HTTP
  // equivalent — otherwise an outage on Meta's side stops the product working
  // at all.
  // ---------------------------------------------------------------------
  app.register(async (secured) => {
    secured.addHook("onRequest", requireAuth);

    secured.get("/offers/current", async (req) => {
      const [cycle] = await db
        .select()
        .from(offerCycles)
        .where(
          and(
            eq(offerCycles.userId, req.userId!),
            inArray(offerCycles.status, ["pending", "prompted", "answered", "previewed", "approved"]),
          ),
        )
        .orderBy(desc(offerCycles.periodMonth))
        .limit(1);

      return {
        cycle: cycle ?? null,
        whatsappEnabled: isWhatsAppConfigured(),
      };
    });

    secured.get("/offers", async (req) => {
      const rows = await db
        .select()
        .from(offerCycles)
        .where(eq(offerCycles.userId, req.userId!))
        .orderBy(desc(offerCycles.periodMonth))
        .limit(24);
      return { cycles: rows };
    });

    secured.post(
      "/offers/current",
      {
        schema: {
          body: z.object({
            offerText: z.string().min(3).max(500),
            // Optional override for the inferred deadline. The inference is a
            // guess by design; this is how the owner corrects it.
            expiresAt: z.string().datetime().optional(),
          }),
        },
      },
      async (req, reply) => {
        const body = req.body as { offerText: string; expiresAt?: string };

        const sub = await liveSubscriptionFor(req.userId!);
        if (!sub) return reply.code(402).send({ error: "no_subscription" });

        const cycle = await ensureCycleForMonth({
          userId: req.userId!,
          subscriptionId: sub.id,
        });

        const { cycle: updated, expiry } = await recordOffer({
          cycleId: cycle.id,
          text: body.offerText,
        });

        if (body.expiresAt) {
          const at = new Date(body.expiresAt);
          await db
            .update(offerCycles)
            .set({ offerExpiresAt: at, updatedAt: new Date() })
            .where(eq(offerCycles.id, updated.id));
        }

        return reply.code(201).send({
          cycleId: updated.id,
          offerText: body.offerText,
          expiresAt: body.expiresAt ? new Date(body.expiresAt) : expiry.expiresAt,
          // Surfaced so the UI can ask rather than assume — an unparsed
          // deadline defaults to end of month, and the owner should see that.
          expiryInferred: !expiry.parsed && !body.expiresAt,
        });
      },
    );

    secured.post(
      "/offers/:cycleId/approve",
      { schema: { params: z.object({ cycleId: z.string().uuid() }) } },
      async (req, reply) => {
        const { cycleId } = req.params as { cycleId: string };
        const [cycle] = await db
          .select()
          .from(offerCycles)
          .where(and(eq(offerCycles.id, cycleId), eq(offerCycles.userId, req.userId!)))
          .limit(1);
        if (!cycle) return reply.code(404).send({ error: "no_such_cycle" });

        const approved = await approveCycle(cycle.id);
        return { status: approved.status, expiresAt: approved.offerExpiresAt };
      },
    );

    // Deadline preview without committing anything — lets the wizard show what
    // "till Sunday" will be read as before the owner relies on it.
    secured.get(
      "/offers/parse",
      { schema: { querystring: z.object({ text: z.string().min(1).max(500) }) } },
      async (req) => {
        const { text } = req.query as { text: string };
        const result = inferOfferExpiry(text, new Date());
        return { expiresAt: result.expiresAt, inferred: !result.parsed };
      },
    );
  });
}

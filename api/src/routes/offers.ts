import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../auth/plugin.js";
import { db } from "../db/index.js";
import { campaigns, offerCycles } from "../db/schema.js";
import {
  applyInboundReply,
  approveCycle,
  ensureCycleForMonth,
  matchPhone,
  mayMessage,
  replyToUnmatchedSender,
  whatsAppUser,
  recordOffer,
  sendPreview,
} from "../lib/offers/index.js";
import { inferOfferExpiry } from "../lib/offers/policy.js";
import { hasMonthlyOffers, hasOfferChanges, type ProductLine } from "../lib/pricing/index.js";
import { handleSwapInbound } from "../lib/offerSwap/whatsapp.js";
import { liveSubscriptionFor } from "../lib/subscriptions/index.js";
import {
  parseInboundAll,
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

      const messages = parseInboundAll(raw);
      const outcomes = [];
      for (const msg of messages) {
        try {
          // Keep it running subscribers: the offer-CHANGE loop (lib/offerSwap,
          // text / photo / voice note / YES button). Off unless
          // OFFER_SWAP_WHATSAPP=on; then { handled: false } and the original
          // loop below runs as before.
          // No account (or several) for this number: one rate-limited
          // "add it in Settings" reply while the loop runs, then nothing.
          const match = await matchPhone(msg.from);
          if (match.kind !== "one") {
            outcomes.push(
              await replyToUnmatchedSender({
                from: msg.from,
                body: msg.body,
                providerRef: msg.providerRef,
                kind: match.kind,
                log: (m, e) => req.log.warn({ extra: e }, m),
              }),
            );
            continue;
          }
          const swap = await handleSwapInbound(msg, { log: (m, e) => req.log.warn({ err: e }, m) });
          if (swap.handled) {
            outcomes.push(swap);
            continue;
          }
          // The original loop reads text only.
          if (msg.kind !== "text") continue;
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
        // This user would actually get the monthly messages (opt-in, mode).
        whatsappEnabled: mayMessage(await whatsAppUser(req.userId!)),
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
        // An offer here sets an expiry that PAUSES the campaign; Keep it
        // running promises the opposite. Its owners change the offer with
        // "Change my offer" instead (lib/offerSwap: a re-cut swapped into the
        // live ad, back to the base ad on the end date), so point them there.
        if (hasOfferChanges(sub.line as ProductLine)) {
          const [c] = await db
            .select({ id: campaigns.id })
            .from(campaigns)
            .where(and(eq(campaigns.userId, req.userId!), isNotNull(campaigns.googleAdGroupResourceName), inArray(campaigns.status, ["live", "paused"])))
            .orderBy(desc(campaigns.launchedAt))
            .limit(1);
          return reply.code(409).send({ error: "plan_uses_offer_changes", campaignId: c?.id ?? null });
        }
        if (!hasMonthlyOffers(sub.line as ProductLine)) return reply.code(409).send({ error: "plan_has_no_offers" });

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

import { and, desc, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../auth/plugin.js";
import { db } from "../db/index.js";
import { offerChanges, users } from "../db/schema.js";
import { loadOwnedCampaign } from "../lib/ownership.js";
import { passComplianceGate, recordAttestation } from "../lib/compliance/index.js";
import {
  cancelOfferChange,
  changeSources,
  confirmOfferChange,
  createOfferChange,
  eligibilityRefusal,
  launchedCreatives,
  offerChangesFor,
  offerChangeView,
  quoteOfferChange,
  resumeCheckout,
} from "../lib/offerSwap/index.js";
import { offerSwapAllowedFor, whatsAppUser } from "../lib/offers/index.js";

// "Change my offer" (2026-11-21, lib/offerSwap): the web half. Every step
// of the WhatsApp loop is reachable here too, and this works fully without
// WhatsApp. Nothing here calls Google: the renderer's swap sweep does
// (lib/offerSwap/sweep.ts), only after the owner said "Put it live" (and
// paid, when the change is not included).

const campaignParams = z.object({ campaignId: z.string().uuid() });
const changeParams = z.object({ changeId: z.string().uuid() });

async function emailFor(userId: string): Promise<string | null> {
  const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
  // Test customers' *.invalid address never goes to Stripe (lib/testMode).
  return u?.email && !u.email.endsWith(".invalid") ? u.email : null;
}

export async function offerChangeRoutes(app: FastifyInstance) {
  app.addHook("onRequest", requireAuth);

  app.get("/campaigns/:campaignId/offer-changes", { schema: { params: campaignParams } }, async (req, reply) => {
    const { campaignId } = req.params as { campaignId: string };
    const campaign = await loadOwnedCampaign(campaignId, req.userId!, reply);
    if (!campaign) return;
    const launched = await launchedCreatives(campaign.id);
    const refusal = eligibilityRefusal(campaign, launched);
    const rows = await offerChangesFor(campaign.id);
    const current = rows.find((r) => ["rendering", "preview", "awaiting_payment", "publishing", "pending_google"].includes(r.status)) ?? null;
    const live = campaign.liveOfferChangeId ? (rows.find((r) => r.id === campaign.liveOfferChangeId) ?? null) : null;
    const lastEnded = rows.find((r) => r.status === "ended") ?? null;
    return {
      eligible: !refusal,
      refusal: refusal?.body ?? null,
      // 'recut' = our template ad re-cut; 'slide' = the owner's own video +
      // a "This month's offer" end slide (no new photo option).
      mode: changeSources(launched).mode,
      quote: await quoteOfferChange(req.userId!),
      current: current ? await offerChangeView(current) : null,
      live: live ? await offerChangeView(live) : null,
      lastEnded: lastEnded ? { id: lastEnded.id, offerText: lastEnded.offerText, endedAt: lastEnded.endedAt } : null,
      lastProblem: (() => {
        const p = rows.find((r) => r.status === "disapproved" || r.status === "failed");
        return p && (!current || p.createdAt > current.createdAt) ? { id: p.id, status: p.status, offerText: p.offerText, error: p.error } : null;
      })(),
      hasBase: Boolean(campaign.baseAdResourceName),
      // The loop runs for THIS owner (mode, internal rule, opt-in); the web
      // shows the "WhatsApp your offer" note from /auth/me `whatsapp`.
      whatsappEnabled: offerSwapAllowedFor(await whatsAppUser(req.userId!)),
    };
  });

  app.post(
    "/campaigns/:campaignId/offer-changes",
    {
      schema: {
        params: campaignParams,
        body: z
          .object({
            offerText: z.string().trim().min(3).max(500),
            endsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
            callToAction: z.string().trim().min(1).max(40).nullish(),
            photoAssetId: z.string().uuid().nullish(),
            attestation: z.unknown().optional(),
          })
          .strict(),
      },
    },
    async (req, reply) => {
      const { campaignId } = req.params as { campaignId: string };
      const body = req.body as { offerText: string; endsOn?: string | null; callToAction?: string | null; photoAssetId?: string | null; attestation?: unknown };
      const campaign = await loadOwnedCampaign(campaignId, req.userId!, reply);
      if (!campaign) return;
      // Taken down, terms, the two ticks: before anything is made.
      if (!(await passComplianceGate(req, reply, campaign, { attestation: body.attestation, terms: true }))) return;
      const res = await createOfferChange({
        campaign,
        userId: req.userId!,
        offerText: body.offerText,
        endsOn: body.endsOn ?? null,
        callToAction: body.callToAction ?? null,
        photoAssetId: body.photoAssetId ?? null,
        source: "web",
        warn: (msg, err) => req.log.warn({ err }, msg),
      });
      if (!res.ok) return reply.code(res.status).send(res.body);
      await recordAttestation({ req, campaign, action: "generate" });
      return reply.code(201).send({ change: await offerChangeView(res.change), quote: await quoteOfferChange(req.userId!) });
    },
  );

  app.post("/offer-changes/:changeId/confirm", { schema: { params: changeParams } }, async (req, reply) => {
    const { changeId } = req.params as { changeId: string };
    const res = await confirmOfferChange({ changeId, userId: req.userId!, userEmail: await emailFor(req.userId!) });
    if (!res.ok) return reply.code(res.status).send(res.body);
    return res;
  });

  app.post("/offer-changes/:changeId/checkout", { schema: { params: changeParams } }, async (req, reply) => {
    const { changeId } = req.params as { changeId: string };
    const res = await resumeCheckout(changeId, req.userId!, await emailFor(req.userId!));
    if (!res) return reply.code(409).send({ error: "no_open_payment" });
    return res;
  });

  app.post("/offer-changes/:changeId/cancel", { schema: { params: changeParams } }, async (req, reply) => {
    const { changeId } = req.params as { changeId: string };
    if (!(await cancelOfferChange(changeId, req.userId!))) return reply.code(409).send({ error: "offer_change_not_cancellable" });
    return { ok: true };
  });

  // The owner's changes across campaigns (dashboard card status chips).
  app.get("/offer-changes", async (req) => {
    const rows = await db
      .select({ id: offerChanges.id, campaignId: offerChanges.campaignId, status: offerChanges.status, offerText: offerChanges.offerText, endsAt: offerChanges.endsAt })
      .from(offerChanges)
      .where(and(eq(offerChanges.userId, req.userId!), eq(offerChanges.kind, "offer"), inArray(offerChanges.status, ["rendering", "preview", "awaiting_payment", "publishing", "pending_google", "live"])))
      .orderBy(desc(offerChanges.createdAt))
      .limit(50);
    return { changes: rows };
  });
}

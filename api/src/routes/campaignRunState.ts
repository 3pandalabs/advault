import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../auth/plugin.js";
import { db } from "../db/index.js";
import { adAccounts, campaigns } from "../db/schema.js";
import { requiresWalletCheck } from "../lib/billing/policy.js";
import { syncCardLimit } from "../lib/billing/managedCard.js";
import { enableCampaign, isMccConfigured, mccAccessToken, pauseCampaign } from "../lib/googleAds/mcc.js";
import { loadOwnedCampaign } from "../lib/ownership.js";
import { ensurePlanForRunning, syncPlanBillingForUser } from "../lib/planBilling/index.js";
import { planGateBody } from "../lib/planBilling/policy.js";
import { canLaunch, MIN_FUNDED_DAYS } from "../lib/wallet/index.js";

// "Pause anytime: no fee while paused." (2026-11-19, lib/planBilling)
//
// The customer's own pause / resume of a LAUNCHED campaign. Only the status of
// an existing Google campaign changes here (PAUSED / ENABLED); nothing is
// created, so launch stays the only route that creates spend. Pausing the last
// running ad stops the $19 plan at the end of its paid period; resuming inside
// that period takes the stop back (no second charge), after it restarts the
// plan (off-session with the saved card, else 402 plan_required -> checkout).
//
// Managed (MCC) accounts only: their status is reachable with the MCC's own
// credential, and they are every account AdVault sells today.

const params = z.object({ campaignId: z.string().uuid() });

export async function campaignRunStateRoutes(app: FastifyInstance) {
  app.register(async (secured) => {
    secured.addHook("onRequest", requireAuth);

    const reach = async (campaign: { adAccountId: string | null; googleCustomerId: string | null; googleCampaignResourceName: string | null }) => {
      const [account] = campaign.adAccountId
        ? await db.select().from(adAccounts).where(eq(adAccounts.id, campaign.adAccountId)).limit(1)
        : [];
      const customerId = campaign.googleCustomerId ?? account?.customerId ?? null;
      if (!account || account.status === "revoked" || !customerId || !campaign.googleCampaignResourceName) return null;
      if (!account.isManaged || !isMccConfigured()) return null;
      return { account, customerId, resourceName: campaign.googleCampaignResourceName };
    };

    secured.post("/campaigns/:campaignId/pause", { schema: { params } }, async (req, reply) => {
      const { campaignId } = req.params as { campaignId: string };
      const campaign = await loadOwnedCampaign(campaignId, req.userId!, reply);
      if (!campaign) return;
      if (campaign.status === "paused") return { campaign, alreadyPaused: true };
      if (campaign.status !== "live" || !campaign.googleCampaignResourceName) {
        return reply.code(409).send({ error: "not_running" });
      }
      const target = await reach(campaign);
      if (!target) {
        return reply.code(409).send({
          error: "ad_account_unavailable",
          detail: "We can't reach this ad's Google account right now. Email 3pandas@3pandalabs.com and we'll pause it.",
        });
      }
      try {
        await pauseCampaign({
          accessToken: await mccAccessToken(),
          customerId: target.customerId,
          campaignResourceName: target.resourceName,
        });
      } catch (err) {
        req.log.error({ err, campaignId }, "pause at Google failed");
        return reply.code(502).send({ error: "google_ads_error", detail: "Google didn't accept the pause. Please try again." });
      }
      const [updated] = await db
        .update(campaigns)
        .set({ status: "paused", updatedAt: new Date() })
        .where(eq(campaigns.id, campaignId))
        .returning();
      if (target.account.billingMode === "platform") {
        await syncCardLimit(req.userId!).catch((err) => req.log.error({ err }, "card limit sync after pause failed"));
      }
      const plan = await syncPlanBillingForUser(req.userId!);
      return { campaign: updated, plan };
    });

    secured.post("/campaigns/:campaignId/resume", { schema: { params } }, async (req, reply) => {
      const { campaignId } = req.params as { campaignId: string };
      const campaign = await loadOwnedCampaign(campaignId, req.userId!, reply);
      if (!campaign) return;
      if (campaign.status === "live") return { campaign, alreadyRunning: true };
      if (campaign.status !== "paused" || !campaign.googleCampaignResourceName) {
        return reply.code(409).send({ error: "not_paused" });
      }
      const today = new Date().toISOString().slice(0, 10);
      if (campaign.endsOn && campaign.endsOn < today) {
        return reply.code(409).send({
          error: "campaign_ended",
          detail: "This ad reached its end date. Make a new campaign to run it again.",
        });
      }
      const target = await reach(campaign);
      if (!target) {
        return reply.code(409).send({
          error: "ad_account_unavailable",
          detail: "We can't reach this ad's Google account right now. Please try again later.",
        });
      }

      // Same money gates as launch: the org must not front spend it doesn't hold.
      if (requiresWalletCheck(target.account)) {
        const funds = await canLaunch(req.userId!, campaign.dailyBudgetCents);
        if (!funds.ok) {
          return reply.code(402).send({
            error: "insufficient_funds",
            balanceMinor: funds.balanceMinor,
            requiredMinor: funds.requiredMinor,
            currencyCode: campaign.currencyCode,
            detail: `Add to your ad budget first: it needs ${MIN_FUNDED_DAYS} days of budget to restart.`,
          });
        }
      }
      const gate = await ensurePlanForRunning(req.userId!);
      if (!gate.ok) return reply.code(402).send(planGateBody(gate));

      try {
        await enableCampaign({
          accessToken: await mccAccessToken(),
          customerId: target.customerId,
          campaignResourceName: target.resourceName,
        });
      } catch (err) {
        req.log.error({ err, campaignId }, "resume at Google failed");
        // A plan restarted for this resume is put back to stopping by the sync.
        await syncPlanBillingForUser(req.userId!);
        return reply.code(502).send({ error: "google_ads_error", detail: "Google didn't accept the restart. Please try again." });
      }
      const [updated] = await db
        .update(campaigns)
        .set({ status: "live", pausedForFundsAt: null, lowBalanceAlertedAt: null, updatedAt: new Date() })
        .where(eq(campaigns.id, campaignId))
        .returning();
      if (target.account.billingMode === "platform") {
        await syncCardLimit(req.userId!).catch((err) => req.log.error({ err }, "card limit sync after resume failed"));
      }
      const plan = await syncPlanBillingForUser(req.userId!);
      return { campaign: updated, plan, planRestarted: gate.restarted === true };
    });
  });
}

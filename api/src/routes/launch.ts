import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../auth/plugin.js";
import { db } from "../db/index.js";
import { adAccounts, campaigns, creatives } from "../db/schema.js";
import { decryptToken } from "../lib/crypto.js";
import { isGoogleAdsConfigured } from "../lib/googleAds/env.js";
import { mccAccessToken } from "../lib/googleAds/mcc.js";
import { GoogleOAuthError, refreshAccessToken } from "../lib/googleAds/oauth.js";
import {
  addLocationTargets,
  createCampaignBudget,
  createVideoCampaign,
  resolveZipCriteria,
} from "../lib/googleAds/campaigns.js";
import { loadOwnedAdAccount, loadOwnedCampaign } from "../lib/ownership.js";
import { canLaunch, MIN_FUNDED_DAYS } from "../lib/wallet/index.js";

// ---------------------------------------------------------------------------
// THE ONLY ROUTE IN THIS CODEBASE THAT SPENDS MONEY.
//
// Everything before this point — uploads, scripts, renders — is free and
// reversible. This is the boundary. Keep it that way: no other route may call
// the Google Ads mutate API, and `campaigns.status` reaches 'live' here alone.
//
// The campaign is created PAUSED at Google (see createVideoCampaign). AdVault
// hands the advertiser a fully-built, geotargeted, budgeted campaign; the
// advertiser presses go in their own Google Ads account. Nothing here starts
// serving impressions on its own.
// ---------------------------------------------------------------------------

export async function launchRoutes(app: FastifyInstance) {
  app.addHook("onRequest", requireAuth);

  app.post(
    "/campaigns/:campaignId/launch",
    {
      schema: {
        params: z.object({ campaignId: z.string().uuid() }),
        body: z.object({ adAccountId: z.string().uuid() }),
      },
    },
    async (req, reply) => {
      if (!isGoogleAdsConfigured()) {
        // Specific code, not a generic 500: the dashboard renders this as
        // "Google Ads launch isn't available yet" rather than as a bug. See
        // infra/google-ads-setup.md for what is missing.
        return reply.code(503).send({ error: "google_ads_not_configured" });
      }

      const { campaignId } = req.params as { campaignId: string };
      const { adAccountId } = req.body as { adAccountId: string };

      const campaign = await loadOwnedCampaign(campaignId, req.userId!, reply);
      if (!campaign) return;

      // Idempotence guard. Without it, a double-clicked Launch button creates
      // two campaigns and two budgets at Google — the advertiser pays twice and
      // this table only remembers one of them.
      if (campaign.googleCampaignResourceName) {
        return reply.code(409).send({ error: "already_launched" });
      }

      const account = await loadOwnedAdAccount(adAccountId, req.userId!, reply);
      if (!account) return;
      if (account.status !== "active") {
        return reply.code(409).send({ error: "ad_account_revoked" });
      }

      // -------------------------------------------------------------------
      // THE WALLET GUARD. Managed accounts only, and non-negotiable there.
      //
      // On a managed (MCC) account, Google bills 3PandaLabs, not the
      // advertiser — so launching without funds means the org finances
      // someone else's advertising. Requiring MIN_FUNDED_DAYS of cover rather
      // than one day is deliberate: the spend sync runs nightly and Google
      // keeps serving until we pause it, so the guard has to lead the spend
      // rather than trail it.
      //
      // Unmanaged (own-OAuth) accounts skip this entirely — the advertiser's
      // own card is charged and the org has no exposure to bound.
      // -------------------------------------------------------------------
      if (account.isManaged) {
        const funds = await canLaunch(req.userId!, campaign.dailyBudgetCents);
        if (!funds.ok) {
          return reply.code(402).send({
            error: "insufficient_funds",
            balanceMinor: funds.balanceMinor,
            requiredMinor: funds.requiredMinor,
            currencyCode: campaign.currencyCode,
            detail: `A managed campaign needs ${MIN_FUNDED_DAYS} days of budget on hand before it can go live.`,
          });
        }
      }

      // At least one rendered creative. Launching with nothing to show would
      // produce a campaign that can never serve, and the advertiser would be
      // left with a budgeted shell in their Google Ads account.
      const ready = await db
        .select({ id: creatives.id })
        .from(creatives)
        .where(and(eq(creatives.campaignId, campaignId), eq(creatives.renderStatus, "ready")));

      if (ready.length === 0) {
        return reply.code(409).send({ error: "no_ready_creatives" });
      }

      const fail = async (code: string, detail: string) => {
        await db
          .update(campaigns)
          .set({ status: "failed", launchError: detail, updatedAt: new Date() })
          .where(eq(campaigns.id, campaignId));
        return reply.code(502).send({ error: code, detail });
      };

      let accessToken: string;
      try {
        // A managed account has no per-user grant — the MCC's own credential
        // reaches it. An unmanaged one uses the advertiser's stored token. The
        // CHECK constraint on ad_accounts guarantees exactly one of these is
        // available, so the non-null assertion below cannot fire in practice.
        accessToken = account.isManaged
          ? await mccAccessToken()
          : await refreshAccessToken(decryptToken(account.refreshTokenCiphertext!));
      } catch (err) {
        // invalid_grant is permanent — the advertiser revoked access or
        // changed their password. Marking the row revoked lets the dashboard
        // prompt a reconnect instead of failing every future launch with the
        // same opaque message.
        if (err instanceof GoogleOAuthError && err.code === "invalid_grant") {
          await db
            .update(adAccounts)
            .set({ status: "revoked" })
            .where(eq(adAccounts.id, adAccountId));
          return reply.code(409).send({ error: "ad_account_revoked" });
        }
        req.log.error({ err, campaignId }, "failed to refresh the Google access token");
        return fail("google_auth_failed", "Could not refresh Google Ads credentials");
      }

      await db
        .update(adAccounts)
        .set({ lastRefreshedAt: new Date() })
        .where(eq(adAccounts.id, adAccountId));

      try {
        // Resolved BEFORE the budget is created. A campaign with no location
        // criteria targets the whole country — the single most expensive way
        // for this app to be wrong — so if the ZIPs don't resolve, nothing
        // chargeable has been created yet and there is nothing to unwind.
        const geoTargetConstants = await resolveZipCriteria({
          accessToken,
          customerId: account.customerId,
          loginCustomerId: account.loginCustomerId,
          zipCodes: campaign.targetZipCodes,
        });

        if (geoTargetConstants.length === 0) {
          return reply.code(400).send({ error: "no_resolvable_zip_codes" });
        }

        // Budget names must be unique within a Google Ads account, and an
        // advertiser reusing a campaign name is normal. The suffix keeps the
        // second launch from colliding with the first.
        const budgetResourceName = await createCampaignBudget({
          accessToken,
          customerId: account.customerId,
          loginCustomerId: account.loginCustomerId,
          name: `${campaign.name} budget (${campaign.id.slice(0, 8)})`,
          dailyBudgetCents: campaign.dailyBudgetCents,
        });

        const campaignResourceName = await createVideoCampaign({
          accessToken,
          customerId: account.customerId,
          loginCustomerId: account.loginCustomerId,
          name: `${campaign.name} (${campaign.id.slice(0, 8)})`,
          budgetResourceName,
        });

        // Persisted immediately, before geo targeting. If the next call fails,
        // the campaign still exists at Google and this row is the only record
        // of it — losing the resource name here would orphan a real, budgeted
        // campaign in the advertiser's account with nothing pointing at it.
        await db
          .update(campaigns)
          .set({ googleBudgetResourceName: budgetResourceName, googleCampaignResourceName: campaignResourceName, googleCustomerId: account.customerId })
          .where(eq(campaigns.id, campaignId));

        await addLocationTargets({
          accessToken,
          customerId: account.customerId,
          loginCustomerId: account.loginCustomerId,
          campaignResourceName,
          geoTargetConstants,
          radiusMiles: campaign.radiusMiles,
        });

        const [updated] = await db
          .update(campaigns)
          .set({
            adAccountId,
            status: "live",
            launchError: null,
            launchedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(campaigns.id, campaignId))
          .returning();

        return {
          campaign: updated,
          // Reported so the advertiser can see when a typo'd ZIP was dropped
          // rather than silently targeting fewer places than they entered.
          zipCodesRequested: campaign.targetZipCodes.length,
          zipCodesTargeted: geoTargetConstants.length,
          // Said plainly in the response as well as the UI: the campaign is
          // built but not serving, and enabling it is the advertiser's call.
          note: "Campaign created in PAUSED state. Review it in Google Ads and enable it when ready.",
        };
      } catch (err) {
        req.log.error({ err, campaignId }, "Google Ads campaign creation failed");
        return fail("google_ads_error", err instanceof Error ? err.message : String(err));
      }
    },
  );
}

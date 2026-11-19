import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../auth/plugin.js";
import { db } from "../db/index.js";
import { adAccounts, campaigns } from "../db/schema.js";
import { decryptToken } from "../lib/crypto.js";
import { isGoogleAdsConfigured } from "../lib/googleAds/env.js";
import { mccAccessToken } from "../lib/googleAds/mcc.js";
import { GoogleOAuthError, refreshAccessToken } from "../lib/googleAds/oauth.js";
import { GoogleAdsApiError } from "../lib/googleAds/client.js";
import { applyAudienceEdit } from "../lib/googleAds/targeting.js";
import { audienceDimensions, languageConstants } from "../lib/audience/google.js";
import {
  TARGETING_VIOLATION_DETAIL,
  audienceFiltersSchema,
  isHousingCategory,
  normalizeAudienceFilters,
  targetingViolations,
} from "../lib/audience/policy.js";
import { loadOwnedCampaign } from "../lib/ownership.js";

// ---------------------------------------------------------------------------
// PUT /campaigns/:id/targeting — "Who should see it", before AND after launch
// (2026-11-20).
//
// Not launched yet: saved on the row, like PATCH; launch sends it.
// Launched (live or paused, a Google campaign exists): applied at Google
// FIRST, in one atomic mutate (lib/googleAds/targeting.ts), and only then
// saved here. If Google refuses, the row keeps what is actually serving and
// the caller gets the reason. PATCH /campaigns refuses audienceFilters once a
// campaign exists at Google, so this is the only way to change it.
//
// The US housing rules (no age / gender / parental status for real estate)
// are checked here exactly as on save and launch, and again in the builder.
// ---------------------------------------------------------------------------

const body = z
  .object({
    audienceFilters: audienceFiltersSchema.nullable(),
  })
  .strict();

export async function targetingRoutes(app: FastifyInstance) {
  app.addHook("onRequest", requireAuth);

  app.put(
    "/campaigns/:campaignId/targeting",
    { schema: { params: z.object({ campaignId: z.string().uuid() }), body } },
    async (req, reply) => {
      const { campaignId } = req.params as { campaignId: string };
      const input = req.body as z.infer<typeof body>;
      const campaign = await loadOwnedCampaign(campaignId, req.userId!, reply);
      if (!campaign) return;

      const audienceFilters = normalizeAudienceFilters(input.audienceFilters);
      const violations = targetingViolations({ ...campaign, audienceFilters });
      // Only the audience rule is this route's business; a ZIP/address
      // problem on the row is PATCH's and launch's to report.
      const audienceViolation = violations.find((v) => v === "housing_demographics_not_allowed");
      if (audienceViolation) {
        return reply
          .code(400)
          .send({ error: audienceViolation, detail: TARGETING_VIOLATION_DETAIL[audienceViolation] });
      }

      const launched = Boolean(campaign.googleCampaignResourceName);
      if (!launched) {
        const [updated] = await db
          .update(campaigns)
          .set({ audienceFilters, updatedAt: new Date() })
          .where(eq(campaigns.id, campaignId))
          .returning();
        return { campaign: updated, appliedAtGoogle: false };
      }

      if (!isGoogleAdsConfigured()) return reply.code(503).send({ error: "google_ads_not_configured" });
      const [account] = campaign.adAccountId
        ? await db.select().from(adAccounts).where(eq(adAccounts.id, campaign.adAccountId)).limit(1)
        : [];
      const customerId = campaign.googleCustomerId ?? account?.customerId ?? null;
      if (!account || account.status === "revoked" || !customerId || !campaign.googleAdGroupResourceName) {
        return reply.code(409).send({
          error: "ad_account_unavailable",
          detail: "We can't reach this ad's Google account right now, so its audience can't be changed.",
        });
      }

      let accessToken: string;
      try {
        accessToken = account.isManaged
          ? await mccAccessToken()
          : await refreshAccessToken(decryptToken(account.refreshTokenCiphertext!));
      } catch (err) {
        if (err instanceof GoogleOAuthError && err.code === "invalid_grant") {
          await db.update(adAccounts).set({ status: "revoked" }).where(eq(adAccounts.id, account.id));
          return reply.code(409).send({ error: "ad_account_revoked" });
        }
        req.log.error({ err, campaignId }, "targeting edit: token refresh failed");
        return reply.code(502).send({ error: "google_auth_failed", detail: "Could not reach Google Ads. Please try again." });
      }

      try {
        const result = await applyAudienceEdit(
          { accessToken, customerId, loginCustomerId: account.loginCustomerId },
          {
            customerId,
            campaignResourceName: campaign.googleCampaignResourceName!,
            adGroupResourceName: campaign.googleAdGroupResourceName,
            audienceDimensions: audienceDimensions(audienceFilters),
            languageConstants: languageConstants(audienceFilters),
            housing: isHousingCategory(campaign.businessCategory),
            // Audience names are unique per account; launch used the bare suffix.
            audienceName: `AdVault audience ${campaign.id.slice(0, 8)} ${Date.now().toString(36)}`,
          },
        );
        const [updated] = await db
          .update(campaigns)
          .set({ audienceFilters, googleAudienceResourceName: result.audienceResourceName, updatedAt: new Date() })
          .where(eq(campaigns.id, campaignId))
          .returning();
        return { campaign: updated, appliedAtGoogle: true, changedAtGoogle: result.changed };
      } catch (err) {
        req.log.error({ err, campaignId }, "targeting edit refused by Google");
        return reply.code(502).send({ error: "google_ads_error", detail: describe(err) });
      }
    },
  );
}

type Failure = { errors?: { message?: string }[] };

function describe(err: unknown): string {
  if (err instanceof GoogleAdsApiError && Array.isArray(err.details)) {
    const msgs = (err.details as Failure[]).flatMap((d) => d.errors ?? []).map((e) => e.message).filter(Boolean);
    if (msgs.length > 0) return `Google didn't accept the change: ${msgs.join("; ")}`.slice(0, 500);
  }
  return "Google didn't accept the change. Nothing was changed. Please try again.";
}

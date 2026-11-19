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
import { applyTargetingEdit } from "../lib/googleAds/targeting.js";
import { adScheduleCriteria, adScheduleSchema, normalizeAdSchedule } from "../lib/schedule/policy.js";
import { audienceDimensions, languageConstants } from "../lib/audience/google.js";
import {
  TARGETING_VIOLATION_DETAIL,
  audienceFiltersSchema,
  isHousingCategory,
  normalizeAudienceFilters,
  targetingViolations,
} from "../lib/audience/policy.js";
import { loadOwnedCampaign } from "../lib/ownership.js";
import { spreadSchedule } from "../lib/schedule/spread.js";
import { categoryKey } from "../lib/categories/key.js";
import { getBalance } from "../lib/wallet/index.js";

// ---------------------------------------------------------------------------
// PUT /campaigns/:id/targeting — "Who should see it" and "When it shows"
// (days + hours, 0037), before AND after launch (2026-11-20). Either or both;
// a field left out is left alone.
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
    audienceFilters: audienceFiltersSchema.nullable().optional(),
    // null = every day, all day.
    adSchedule: adScheduleSchema.nullable().optional(),
    // "$55 a month": hand the days back to AdVault, which spreads the ad
    // budget across the month (lib/schedule/spread.ts). Sending adSchedule
    // instead makes the schedule the owner's own ('custom').
    scheduleMode: z.literal("spread").optional(),
  })
  .strict()
  .refine((b) => b.audienceFilters !== undefined || b.adSchedule !== undefined || b.scheduleMode !== undefined, {
    message: "send audienceFilters, adSchedule and/or scheduleMode",
  })
  .refine((b) => !(b.adSchedule !== undefined && b.scheduleMode !== undefined), {
    message: "send adSchedule or scheduleMode, not both",
  });

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

      const touchAudience = input.audienceFilters !== undefined;
      const spread = input.scheduleMode === "spread";
      const touchSchedule = input.adSchedule !== undefined || spread;
      const scheduleMode = spread ? "spread" : input.adSchedule !== undefined ? "custom" : campaign.scheduleMode;
      const audienceFilters = touchAudience ? normalizeAudienceFilters(input.audienceFilters) : campaign.audienceFilters;
      // Spread before launch: launch picks the days from the budget then.
      // After launch: from the ad budget on hand now.
      const adSchedule = spread
        ? campaign.googleCampaignResourceName
          ? spreadSchedule({
              monthlyBudgetMinor: (await getBalance(req.userId!))?.balanceMinor ?? 0,
              dailyMinor: campaign.dailyBudgetCents,
              categoryKey: categoryKey(campaign.businessCategory),
            })
          : null
        : touchSchedule
          ? normalizeAdSchedule(input.adSchedule)
          : campaign.adSchedule;
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
          .set({ audienceFilters, adSchedule, scheduleMode, updatedAt: new Date() })
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
          detail: "We can't reach this ad's Google account right now, so this can't be changed.",
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
        const refs = {
          customerId,
          campaignResourceName: campaign.googleCampaignResourceName!,
          adGroupResourceName: campaign.googleAdGroupResourceName,
        };
        const result = await applyTargetingEdit(
          { accessToken, customerId, loginCustomerId: account.loginCustomerId },
          refs,
          {
            audience: touchAudience
              ? {
                  ...refs,
                  audienceDimensions: audienceDimensions(audienceFilters),
                  languageConstants: languageConstants(audienceFilters),
                  housing: isHousingCategory(campaign.businessCategory),
                  // Audience names are unique per account; launch used the bare suffix.
                  audienceName: `AdVault audience ${campaign.id.slice(0, 8)} ${Date.now().toString(36)}`,
                }
              : undefined,
            adSchedule: touchSchedule ? adScheduleCriteria(adSchedule) : undefined,
          },
        );
        const [updated] = await db
          .update(campaigns)
          .set({
            audienceFilters,
            adSchedule,
            scheduleMode,
            googleAudienceResourceName: result.audienceResourceName,
            updatedAt: new Date(),
          })
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

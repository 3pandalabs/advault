import { desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../auth/plugin.js";
import { db } from "../db/index.js";
import { campaigns, creatives } from "../db/schema.js";
import { loadOwnedCampaign } from "../lib/ownership.js";
import { budgetBelowMinimum } from "../lib/pricing/index.js";
import { realtySchema } from "../lib/realty/index.js";
import { markAppUsed } from "../lib/sharedAccount/index.js";
import {
  TARGETING_VIOLATION_DETAIL,
  audienceFiltersSchema,
  normalizeAudienceFilters,
  targetAddressSchema,
  targetingViolations,
  type AudienceFilters,
  type TargetingInput,
  type TargetingViolation,
} from "../lib/audience/policy.js";

// US ZIPs, 5 digits. Validated here as well as by the CHECK constraint so the
// wizard gets a field-level error instead of a 400 with no shape to it.
// US ZIP (5 digits) or Indian PIN (6 digits). Both markets, one field.
//
// This was `^\d{5}$` and it made India unusable: a Bengaluru advertiser typing
// 560001 was told "must be a 5-digit ZIP code" and could not create a campaign
// at all. Nothing downstream cared — Google's location targeting takes the
// string as a name — so the entire market was closed by a validation rule.
// Found by dogfooding the product on 3PandaLabs itself, which is the only
// reason it surfaced before a customer hit it.
const postalCode = z
  .string()
  .regex(/^\d{5}$|^\d{6}$/, "must be a 5-digit US ZIP or 6-digit Indian PIN code");

const campaignFields = z.object({
  name: z.string().min(1).max(120),
  businessName: z.string().min(1).max(160),
  businessCategory: z.string().min(1).max(80),
  callToAction: z.string().min(1).max(40).default("Call now"),
  // Constrained to http(s) so a campaign can't ship a javascript: or data:
  // landing URL into a live ad. OPTIONAL since 2026-11-15: a business with no
  // website can still make ads (blank = null); launch requires one
  // (landing_url_required in routes/launch.ts).
  landingUrl: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z
      .string()
      .url()
      .max(500)
      .refine((u) => /^https?:\/\//i.test(u), { message: "must be an http(s) URL" })
      .nullish(),
  ),
  offerDetails: z.string().max(2000).nullish(),
  // One country per campaign: launch resolves every code against a single
  // country (US for 5 digits, IN for 6), so a mixed list would silently drop
  // half of its targets.
  //
  // May be empty ONLY for a real-estate campaign, which targets a radius
  // around `targetAddress` instead (US housing ads can't target ZIPs). That
  // cross-field rule is targetingViolations() below, not this schema.
  targetZipCodes: z
    .array(postalCode)
    .max(50)
    .refine((codes) => new Set(codes.map((c) => c.length)).size <= 1, {
      message: "mix of US ZIP and Indian PIN codes",
    }),
  radiusMiles: z.number().int().min(1).max(50).default(10),
  // Minor units. The real floor is per currency and checked below
  // (budgetBelowMinimum in lib/pricing): $5/day for USD, Google's Demand Gen
  // per-day minimum. It was lowered to $1 on 2026-11-10 and every $1-$4.99
  // campaign then failed at launch with BUDGET_BELOW_PER_DAY_MINIMUM (found
  // by a validateOnly dry run, 2026-11-19). The $500/day ceiling is a
  // guardrail against a mistyped budget, not a product limit.
  dailyBudgetCents: z.number().int().min(100).max(50_000),
  currencyCode: z.string().length(3).default("USD"),
  // How long the ad runs: 7 or 14 days, null/absent = always on (migration
  // 0033). Launch sends Google an end date for 7/14 (runEndDate in lib/pricing).
  runDays: z.union([z.literal(7), z.literal(14)]).nullish(),
  // Real estate only: the listing address a radius is drawn around.
  targetAddress: targetAddressSchema.nullish(),
  // Optional "Who should see it" filters. Absent/null = everyone.
  audienceFilters: audienceFiltersSchema.nullish(),
  // Real estate only: listing/open-house ad or agent ad (lib/realty).
  realty: realtySchema.nullish(),
});

// The create schema: the fields plus the currency-aware budget floor. PATCH
// uses campaignFields.partial() and checks the floor against the merged row.
export const campaignInput = campaignFields.superRefine((v, ctx) => {
  const below = budgetBelowMinimum(v.dailyBudgetCents, v.currencyCode);
  if (below) {
    ctx.addIssue({
      code: "custom",
      path: ["dailyBudgetCents"],
      message: `must be at least ${below.minDailyBudgetMinor} (${below.currencyCode} minor units): ${below.detail}`,
    });
  }
});

type CampaignInput = z.infer<typeof campaignFields>;

/**
 * Normalises the filters and applies the targeting rules (housing policy,
 * ZIP-or-address). Returns the values to write, or the first violation.
 */
function checkTargeting(
  merged: TargetingInput,
): { ok: true; audienceFilters: AudienceFilters | null } | { ok: false; error: TargetingViolation } {
  const audienceFilters = normalizeAudienceFilters(merged.audienceFilters);
  const violations = targetingViolations({ ...merged, audienceFilters });
  if (violations.length > 0) return { ok: false, error: violations[0]! };
  return { ok: true, audienceFilters };
}

export async function campaignRoutes(app: FastifyInstance) {
  app.addHook("onRequest", requireAuth);

  app.post("/campaigns", { schema: { body: campaignInput } }, async (req, reply) => {
    const body = req.body as CampaignInput;
    const targeting = checkTargeting({
      businessCategory: body.businessCategory,
      targetZipCodes: body.targetZipCodes,
      targetAddress: body.targetAddress,
      audienceFilters: body.audienceFilters,
    });
    if (!targeting.ok) {
      return reply
        .code(400)
        .send({ error: targeting.error, detail: TARGETING_VIOLATION_DETAIL[targeting.error] });
    }
    const [campaign] = await db
      .insert(campaigns)
      .values({
        ...body,
        runDays: body.runDays ?? null,
        targetAddress: body.targetAddress ?? null,
        audienceFilters: targeting.audienceFilters,
        realty: body.realty ?? null,
        userId: req.userId!,
      })
      .returning();
    // Shared account: the first campaign is the account's first AdVault use
    // (lib/sharedAccount). Never fails the create.
    await markAppUsed(db, req.userId!, "advault").catch((err) => req.log.warn({ err }, "advault first-use stamp failed"));
    return reply.code(201).send(campaign);
  });

  app.get("/campaigns", async (req) => {
    return db
      .select()
      .from(campaigns)
      .where(eq(campaigns.userId, req.userId!))
      .orderBy(desc(campaigns.createdAt));
  });

  app.get(
    "/campaigns/:campaignId",
    { schema: { params: z.object({ campaignId: z.string().uuid() }) } },
    async (req, reply) => {
      const { campaignId } = req.params as { campaignId: string };
      const campaign = await loadOwnedCampaign(campaignId, req.userId!, reply);
      if (!campaign) return;

      const rows = await db
        .select()
        .from(creatives)
        .where(eq(creatives.campaignId, campaignId))
        .orderBy(desc(creatives.createdAt));

      return { ...campaign, creatives: rows };
    },
  );

  app.patch(
    "/campaigns/:campaignId",
    {
      schema: {
        params: z.object({ campaignId: z.string().uuid() }),
        body: campaignFields.partial(),
      },
    },
    async (req, reply) => {
      const { campaignId } = req.params as { campaignId: string };
      const campaign = await loadOwnedCampaign(campaignId, req.userId!, reply);
      if (!campaign) return;

      // Editing a live campaign here would silently diverge from what is
      // actually serving at Google — the budget in this table would say one
      // thing and the advertiser's card would be charged another. Changes to a
      // live campaign belong in Google Ads until this app can push updates.
      if (campaign.status === "live") {
        return reply.code(409).send({ error: "campaign_is_live" });
      }

      // Checked against the row as it WILL be, so changing only the category
      // to "Real estate" on a campaign with age filters is refused too.
      const body = req.body as Partial<CampaignInput>;
      // The run length only matters at launch (it becomes Google's end date),
      // so once a campaign exists at Google changing it here would be a lie.
      if (body.runDays !== undefined && campaign.googleCampaignResourceName) {
        return reply.code(409).send({ error: "campaign_already_launched" });
      }
      // Same for the audience of a paused-but-launched campaign: the row would
      // diverge from Google. PUT /campaigns/:id/targeting applies it at Google.
      if (body.audienceFilters !== undefined && campaign.googleCampaignResourceName) {
        return reply.code(409).send({ error: "campaign_already_launched" });
      }
      // Same floor as create, against the row as it will be.
      const below = budgetBelowMinimum(
        body.dailyBudgetCents ?? campaign.dailyBudgetCents,
        body.currencyCode ?? campaign.currencyCode,
      );
      if (below && (body.dailyBudgetCents !== undefined || body.currencyCode !== undefined)) {
        return reply.code(400).send(below);
      }
      const targeting = checkTargeting({
        businessCategory: body.businessCategory ?? campaign.businessCategory,
        targetZipCodes: body.targetZipCodes ?? campaign.targetZipCodes,
        targetAddress: body.targetAddress !== undefined ? body.targetAddress : campaign.targetAddress,
        audienceFilters:
          body.audienceFilters !== undefined ? body.audienceFilters : campaign.audienceFilters,
      });
      if (!targeting.ok) {
        return reply
          .code(400)
          .send({ error: targeting.error, detail: TARGETING_VIOLATION_DETAIL[targeting.error] });
      }

      const [updated] = await db
        .update(campaigns)
        .set({
          ...body,
          ...(body.audienceFilters !== undefined ? { audienceFilters: targeting.audienceFilters } : {}),
          updatedAt: new Date(),
        })
        .where(eq(campaigns.id, campaignId))
        .returning();
      return updated;
    },
  );

  app.delete(
    "/campaigns/:campaignId",
    { schema: { params: z.object({ campaignId: z.string().uuid() }) } },
    async (req, reply) => {
      const { campaignId } = req.params as { campaignId: string };
      const campaign = await loadOwnedCampaign(campaignId, req.userId!, reply);
      if (!campaign) return;

      // Deleting the local row would not stop a live campaign from spending —
      // it would just remove the only place the advertiser can see it. Pause
      // at Google first.
      if (campaign.status === "live") {
        return reply.code(409).send({ error: "campaign_is_live" });
      }

      await db.delete(campaigns).where(eq(campaigns.id, campaignId));
      return reply.code(204).send();
    },
  );
}

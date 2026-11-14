import { desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../auth/plugin.js";
import { db } from "../db/index.js";
import { campaigns, creatives } from "../db/schema.js";
import { loadOwnedCampaign } from "../lib/ownership.js";
import { realtySchema } from "../lib/realty/index.js";
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

const campaignInput = z.object({
  name: z.string().min(1).max(120),
  businessName: z.string().min(1).max(160),
  businessCategory: z.string().min(1).max(80),
  callToAction: z.string().min(1).max(40).default("Call now"),
  // Constrained to http(s) so a campaign can't ship a javascript: or data:
  // landing URL into a live ad.
  landingUrl: z.string().url().max(500).refine((u) => /^https?:\/\//i.test(u), {
    message: "must be an http(s) URL",
  }),
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
  // Minor units. A $1/day floor (lowered from $5 on 2026-11-10 so a shop can
  // start tiny; Google spends very small budgets slowly, which is why the
  // wizard suggests $15). The $500/day ceiling is a guardrail against a
  // mistyped budget, not a product limit. Matches us-managed in lib/pricing.
  dailyBudgetCents: z.number().int().min(100).max(50_000),
  currencyCode: z.string().length(3).default("USD"),
  // Real estate only: the listing address a radius is drawn around.
  targetAddress: targetAddressSchema.nullish(),
  // Optional "Who should see it" filters. Absent/null = everyone.
  audienceFilters: audienceFiltersSchema.nullish(),
  // Real estate only: listing/open-house ad or agent ad (lib/realty).
  realty: realtySchema.nullish(),
});

type CampaignInput = z.infer<typeof campaignInput>;

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
        targetAddress: body.targetAddress ?? null,
        audienceFilters: targeting.audienceFilters,
        realty: body.realty ?? null,
        userId: req.userId!,
      })
      .returning();
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
        body: campaignInput.partial(),
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

import { and, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../auth/plugin.js";
import { db } from "../db/index.js";
import { campaigns, creatives, purchases } from "../db/schema.js";
import { loadOwnedCampaign } from "../lib/ownership.js";
import { budgetBelowMinimum } from "../lib/pricing/index.js";
import { realtySchema } from "../lib/realty/index.js";
import { claimBlock } from "../lib/categories/claims.js";
import { categoryKey } from "../lib/categories/key.js";
import { markAppUsed } from "../lib/sharedAccount/index.js";
import { reevaluateCompliance } from "../lib/compliance/index.js";
import { takenDownRefusal } from "../lib/compliance/policy.js";
import { beforeAfterInputSchema } from "../lib/beforeAfter/policy.js";
import { badgesInputSchema, checkBadges } from "./badges.js";
import { categoryExtrasSchema, checkCategoryExtras } from "./categoryExtras.js";
import { checkBeforeAfter } from "./beforeAfter.js";
import { adScheduleSchema, normalizeAdSchedule } from "../lib/schedule/policy.js";
import {
  TARGETING_VIOLATION_DETAIL,
  audienceFiltersSchema,
  isHousingCategory,
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
  // Optional days + hours (lib/schedule). Absent/null = every day, all day.
  adSchedule: adScheduleSchema.nullish(),
  // Real estate only: listing/open-house ad or agent ad (lib/realty).
  realty: realtySchema.nullish(),
});

// The create schema: the fields, the inputs that shape the FIRST ad, and the
// currency-aware budget floor. PATCH uses campaignFields.partial() (without
// badges/extras/before-after: those have their own PUT routes) and checks the
// floor against the merged row.
//
// badges / categoryExtras / beforeAfter (2026-11-20): the wizard sends them
// with the create, so they are on the row before any ad is generated or paid
// for. Same schemas and the same checks as PUT /campaigns/:id/badges,
// /extras and /before-after (checkBadges, checkCategoryExtras,
// checkBeforeAfter); any problem refuses the whole create, so no half-made
// campaign is left behind.
export const campaignInput = campaignFields
  .extend({
    badges: badgesInputSchema.nullish(),
    categoryExtras: categoryExtrasSchema.nullish(),
    beforeAfter: beforeAfterInputSchema.nullish(),
  })
  .superRefine((v, ctx) => {
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
type CampaignCreateInput = z.infer<typeof campaignInput>;

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

/** Claim checks (lib/categories/claims): the offer text Google clearly forbids, or null. */
function blockedClaim(category: string, offerDetails: string | null | undefined) {
  const b = claimBlock(categoryKey(category), offerDetails);
  return b ? { error: "claim_not_allowed", detail: b.reason, phrase: b.phrase } : null;
}

// What the ad at Google was launched with (2026-11-24): never editable here
// after launch, or the row would say one thing and Google another.
const LAUNCHED_FIXED = ["businessCategory", "targetZipCodes", "radiusMiles", "targetAddress", "realty"] as const;

// Money taken that this campaign still owes something for.
const PAID_STATUSES = ["paid", "producing", "delivered"];

async function hasPayment(campaignId: string, skus?: string[]): Promise<boolean> {
  const [row] = await db
    .select({ id: purchases.id })
    .from(purchases)
    .where(
      and(
        eq(purchases.campaignId, campaignId),
        inArray(purchases.status, PAID_STATUSES),
        ...(skus ? [inArray(purchases.sku, skus)] : []),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** An ad was made, or paid for, with this category in its script. Own uploads don't count. */
async function categoryLocked(campaignId: string): Promise<boolean> {
  const [made] = await db
    .select({ id: creatives.id })
    .from(creatives)
    .where(and(eq(creatives.campaignId, campaignId), ne(creatives.kind, "upload")))
    .limit(1);
  return Boolean(made) || hasPayment(campaignId, ["new_ad", "cinematic", "cinematic_pack"]);
}

export async function campaignRoutes(app: FastifyInstance) {
  app.addHook("onRequest", requireAuth);

  app.post("/campaigns", { schema: { body: campaignInput } }, async (req, reply) => {
    const { badges: badgesIn, categoryExtras: extrasIn, beforeAfter: pairsIn, ...body } = req.body as CampaignCreateInput;
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
    const claim = blockedClaim(body.businessCategory, body.offerDetails);
    if (claim) return reply.code(400).send(claim);

    // What shapes the first ad, checked exactly like the PUT routes.
    const badges = badgesIn ? checkBadges(body.businessCategory, badgesIn) : null;
    if (badges && !badges.ok) return reply.code(400).send({ error: badges.error, detail: badges.detail });
    const extras = extrasIn ? await checkCategoryExtras(body.businessCategory, extrasIn, req.userId!) : null;
    if (extras && !extras.ok) return reply.code(400).send({ error: extras.error, ...(extras.detail ? { detail: extras.detail } : {}) });
    const pairs = pairsIn ? await checkBeforeAfter(body.businessCategory, pairsIn, req.userId!) : null;
    if (pairs && !pairs.ok) return reply.code(400).send({ error: pairs.error, ...(pairs.detail ? { detail: pairs.detail } : {}) });
    const badgeSel = badges?.ok ? badges.sel : null;
    const pairList = pairs?.ok ? pairs.pairs : null;
    const now = new Date();

    const [campaign] = await db
      .insert(campaigns)
      .values({
        ...body,
        badges: badgeSel,
        badgesAttestedAt: badgeSel ? now : null,
        badgesAttestedBy: badgeSel ? req.userId! : null,
        categoryExtras: extras?.ok ? extras.extras : null,
        beforeAfter: pairList,
        beforeAfterAttestedAt: pairList ? now : null,
        beforeAfterAttestedBy: pairList ? req.userId! : null,
        runDays: body.runDays ?? null,
        adSchedule: normalizeAdSchedule(body.adSchedule),
        // An owner-chosen schedule is theirs; otherwise AdVault spreads the budget (lib/schedule/spread.ts).
        scheduleMode: body.adSchedule ? "custom" : "spread",
        targetAddress: body.targetAddress ?? null,
        audienceFilters: targeting.audienceFilters,
        realty: body.realty ?? null,
        userId: req.userId!,
      })
      .returning();
    // Shared account: the first campaign is the account's first AdVault use
    // (lib/sharedAccount). Never fails the create.
    await markAppUsed(db, req.userId!, "advault").catch((err) => req.log.warn({ err }, "advault first-use stamp failed"));
    // REVIEW phrases (lib/compliance/claimRules) -> needs_review; launch waits.
    const checked = await reevaluateCompliance(campaign!.id);
    return reply.code(201).send(checked ?? campaign);
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
        // Offer-change re-cuts (lib/offerSwap) live on the "Change my offer"
        // card (GET /campaigns/:id/offer-changes), never in the ad list,
        // whose redo / edit / upload buttons must not touch them.
        .where(and(eq(creatives.campaignId, campaignId), isNull(creatives.offerChangeId)))
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
      let body = req.body as Partial<CampaignInput>;
      if (campaign.googleCampaignResourceName && LAUNCHED_FIXED.some((k) => body[k] !== undefined)) {
        return reply.code(409).send({ error: "campaign_already_launched" });
      }
      // A new category: what belonged to the old one goes. Crossing in or out
      // of housing also drops the old area and audience, so a housing ad can
      // never keep ZIPs or filters (and needs its own address, checked below).
      const newCategory = body.businessCategory !== undefined && body.businessCategory !== campaign.businessCategory;
      let categoryReset: Partial<typeof campaigns.$inferInsert> = {};
      if (newCategory) {
        if (await categoryLocked(campaignId)) return reply.code(409).send({ error: "category_locked" });
        categoryReset = {
          badges: null,
          badgesAttestedAt: null,
          badgesAttestedBy: null,
          categoryExtras: null,
          beforeAfter: null,
          beforeAfterAttestedAt: null,
          beforeAfterAttestedBy: null,
        };
        const housing = isHousingCategory(body.businessCategory);
        if (housing !== isHousingCategory(campaign.businessCategory)) {
          body = housing
            ? { ...body, targetZipCodes: [], targetAddress: body.targetAddress ?? null, audienceFilters: null, realty: body.realty ?? null }
            : { ...body, targetZipCodes: body.targetZipCodes ?? [], targetAddress: null, audienceFilters: null, realty: null };
        }
      }
      // The run length only matters at launch (it becomes Google's end date),
      // so once a campaign exists at Google changing it here would be a lie.
      if (body.runDays !== undefined && campaign.googleCampaignResourceName) {
        return reply.code(409).send({ error: "campaign_already_launched" });
      }
      // Same for the audience of a paused-but-launched campaign: the row would
      // diverge from Google. PUT /campaigns/:id/targeting applies it at Google.
      if ((body.audienceFilters !== undefined || body.adSchedule !== undefined) && campaign.googleCampaignResourceName) {
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
      if (body.offerDetails !== undefined || body.businessCategory !== undefined) {
        const claim = blockedClaim(
          body.businessCategory ?? campaign.businessCategory,
          body.offerDetails !== undefined ? body.offerDetails : campaign.offerDetails,
        );
        if (claim) return reply.code(400).send(claim);
      }

      const [updated] = await db
        .update(campaigns)
        .set({
          ...categoryReset,
          ...body,
          ...(body.audienceFilters !== undefined ? { audienceFilters: targeting.audienceFilters } : {}),
          ...(body.adSchedule !== undefined ? { adSchedule: normalizeAdSchedule(body.adSchedule), scheduleMode: "custom" as const } : {}),
          updatedAt: new Date(),
        })
        .where(eq(campaigns.id, campaignId))
        .returning();
      // An edit that brings in a new REVIEW phrase sets needs_review again,
      // even after an admin approved the earlier wording (lib/compliance).
      return (await reevaluateCompliance(campaignId)) ?? updated;
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
      // A removed ad stays on record (its reports point at it).
      const removed = takenDownRefusal(campaign);
      if (removed) return reply.code(removed.status).send(removed.body);
      // Only a draft that never ran and was never paid for (2026-11-24).
      if (campaign.googleCampaignResourceName) return reply.code(409).send({ error: "campaign_already_launched" });
      if (campaign.status === "rendering") return reply.code(409).send({ error: "campaign_rendering" });
      if (await hasPayment(campaignId)) return reply.code(409).send({ error: "campaign_has_payment" });

      await db.delete(campaigns).where(eq(campaigns.id, campaignId));
      return reply.code(204).send();
    },
  );
}

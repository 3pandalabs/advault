import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../auth/plugin.js";
import { db } from "../db/index.js";
import { campaigns } from "../db/schema.js";
import { loadOwnedCampaign } from "../lib/ownership.js";
import { categoryKey } from "../lib/categories/key.js";
import {
  BADGES,
  BADGE_DETAIL,
  badgeChips,
  badgeOptions,
  badgeViolation,
  type BadgeId,
  type BadgeSelection,
} from "../lib/categories/badges.js";

// Badges and credentials (2026-11-20, migration 0039, lib/categories/badges).
// The owner ticks the ones that are true and attests it; they go into the
// NEXT ad made (end-card chips + a line for the script writer). Changing them
// never re-renders anything and never touches a live ad.

const params = z.object({ campaignId: z.string().uuid() });
const badgeIds = Object.keys(BADGES) as [BadgeId, ...BadgeId[]];

export const badgesInputSchema = z
  .object({
    ids: z.array(z.enum(badgeIds)).max(10),
    licenseNumber: z.string().max(40).nullish(),
    attested: z.boolean().optional(),
  })
  .strict();
export type BadgesInput = z.infer<typeof badgesInputSchema>;

/**
 * The one badge check, shared by this PUT and POST /campaigns (the wizard
 * sends badges with the create so the first ad has them). `sel` null = none.
 */
export function checkBadges(
  category: string,
  body: BadgesInput,
): { ok: true; sel: BadgeSelection | null } | { ok: false; error: string; detail: string } {
  const sel: BadgeSelection = {
    ids: body.ids,
    ...(body.ids.includes("license_number") ? { licenseNumber: (body.licenseNumber ?? "").trim() } : {}),
  };
  const violation = badgeViolation(categoryKey(category), sel, body.attested === true);
  if (violation) return { ok: false, error: violation, detail: BADGE_DETAIL[violation] };
  return { ok: true, sel: sel.ids.length === 0 ? null : sel };
}

function view(category: string, sel: BadgeSelection | null, attestedAt: Date | null) {
  return {
    options: badgeOptions(categoryKey(category)),
    selection: sel ?? { ids: [] },
    chips: badgeChips(sel),
    attestedAt,
  };
}

export async function badgeRoutes(app: FastifyInstance) {
  app.addHook("onRequest", requireAuth);

  app.get("/campaigns/:campaignId/badges", { schema: { params } }, async (req, reply) => {
    const { campaignId } = req.params as { campaignId: string };
    const campaign = await loadOwnedCampaign(campaignId, req.userId!, reply);
    if (!campaign) return;
    return view(campaign.businessCategory, campaign.badges, campaign.badgesAttestedAt);
  });

  app.put("/campaigns/:campaignId/badges", { schema: { params, body: badgesInputSchema } }, async (req, reply) => {
    const { campaignId } = req.params as { campaignId: string };
    const campaign = await loadOwnedCampaign(campaignId, req.userId!, reply);
    if (!campaign) return;
    const checked = checkBadges(campaign.businessCategory, req.body as BadgesInput);
    if (!checked.ok) return reply.code(400).send({ error: checked.error, detail: checked.detail });

    const empty = checked.sel === null;
    const [updated] = await db
      .update(campaigns)
      .set({
        badges: checked.sel,
        badgesAttestedAt: empty ? null : new Date(),
        badgesAttestedBy: empty ? null : req.userId!,
        updatedAt: new Date(),
      })
      .where(eq(campaigns.id, campaign.id))
      .returning();
    return view(updated!.businessCategory, updated!.badges, updated!.badgesAttestedAt);
  });
}

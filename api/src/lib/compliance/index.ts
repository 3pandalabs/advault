// Client attestation & compliance (2026-11-20, migration 0043). CLAUDE.md
// "Client attestation & compliance" has the rules; this is the DB half.
//
// - Attestation: every order, generate, redo, upload and launch carries the
//   client's two ticks (`attestation: {accuracy, media, version}`), refused
//   with 400 attestation_required, and is recorded in ad_attestations with the
//   exact text, IP, user agent and a snapshot of the ad (append-only table).
// - Terms: order / generate / redo / launch need the current TERMS_VERSION in
//   terms_acceptances (409 terms_not_accepted).
// - Review: REVIEW phrases (claimRules) set compliance_status needs_review;
//   launch refuses (409 needs_review) until an admin approves.
// - Takedown: compliance_status taken_down refuses everything that makes,
//   launches or resumes the ad (409 ad_taken_down).

import { and, desc, eq, inArray } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import { db } from "../../db/index.js";
import { adAttestations, assets, campaigns, creatives, termsAcceptances } from "../../db/schema.js";
import { categoryKey } from "../categories/key.js";
import { adScriptSchema } from "../script/schema.js";
import {
  attestationRefusal,
  firstIp,
  needsReviewRefusal,
  nextCompliance,
  reviewReasons,
  takenDownRefusal,
  termsRefusal,
  type ComplianceText,
  type Refusal,
} from "./policy.js";
import { ATTESTATION_VERSION, attestationSnapshotText } from "./texts.js";

type Campaign = typeof campaigns.$inferSelect;
type Action = "order" | "generate" | "redo" | "upload" | "launch" | "website";

/** cf-connecting-ip (Cloudflare in front), else Fastify's req.ip (trustProxy). */
export function clientIp(req: FastifyRequest): string | null {
  return firstIp(req.headers["cf-connecting-ip"]) ?? (req.ip ? req.ip.slice(0, 64) : null);
}

export function clientUserAgent(req: FastifyRequest): string | null {
  const ua = req.headers["user-agent"];
  return typeof ua === "string" && ua ? ua.slice(0, 500) : null;
}

export async function acceptedTermsVersion(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ version: termsAcceptances.version })
    .from(termsAcceptances)
    .where(eq(termsAcceptances.userId, userId))
    .orderBy(desc(termsAcceptances.createdAt))
    .limit(1);
  return row?.version ?? null;
}

export async function recordTermsAcceptance(userId: string, version: string, req: FastifyRequest): Promise<void> {
  await db.insert(termsAcceptances).values({ userId, version, ipAddress: clientIp(req), userAgent: clientUserAgent(req) });
}

/**
 * The gates in front of anything that makes, pays for or launches an ad, in
 * order: taken down, terms, (launch only) needs review, attestation. Sends the
 * refusal and returns false, or returns true.
 */
export async function passComplianceGate(
  req: FastifyRequest,
  reply: FastifyReply,
  campaign: Campaign,
  opts: { attestation: unknown; terms?: boolean; review?: boolean; requireAttestation?: boolean },
): Promise<boolean> {
  const refusal: Refusal | null =
    takenDownRefusal(campaign) ??
    (opts.terms ? termsRefusal(await acceptedTermsVersion(req.userId!)) : null) ??
    (opts.review ? needsReviewRefusal(campaign) : null) ??
    (opts.requireAttestation === false ? null : attestationRefusal(opts.attestation));
  if (!refusal) return true;
  reply.code(refusal.status).send(refusal.body);
  return false;
}

/** What the ad said at the moment of the tick. Never presigned URLs. */
export async function contentSnapshot(campaign: Campaign, extra: { assetKeys?: string[] } = {}): Promise<Record<string, unknown>> {
  const rows = await db
    .select({
      id: creatives.id,
      kind: creatives.kind,
      aspectRatio: creatives.aspectRatio,
      version: creatives.version,
      script: creatives.script,
      sourceAssetKeys: creatives.sourceAssetKeys,
      videoKey: creatives.videoKey,
      youtubeVideoId: creatives.youtubeVideoId,
    })
    .from(creatives)
    .where(eq(creatives.campaignId, campaign.id));
  return {
    campaign: {
      id: campaign.id,
      publicId: campaign.publicId,
      name: campaign.name,
      businessName: campaign.businessName,
      businessCategory: campaign.businessCategory,
      callToAction: campaign.callToAction,
      landingUrl: campaign.landingUrl,
      offerDetails: campaign.offerDetails,
      targetZipCodes: campaign.targetZipCodes,
      currencyCode: campaign.currencyCode,
      dailyBudgetCents: campaign.dailyBudgetCents,
      realty: campaign.realty,
      badges: campaign.badges,
      badgesAttestedAt: campaign.badgesAttestedAt,
      categoryExtras: campaign.categoryExtras,
      beforeAfter: campaign.beforeAfter,
      beforeAfterAttestedAt: campaign.beforeAfterAttestedAt,
      complianceStatus: campaign.complianceStatus,
    },
    ...(extra.assetKeys ? { assetKeys: extra.assetKeys } : {}),
    creatives: rows,
  };
}

/** R2 keys of this user's assets, in the order given (unknown ids dropped). */
export async function assetKeysFor(userId: string, assetIds: string[]): Promise<string[]> {
  if (assetIds.length === 0) return [];
  const rows = await db
    .select({ id: assets.id, r2Key: assets.r2Key })
    .from(assets)
    .where(and(eq(assets.userId, userId), inArray(assets.id, assetIds)));
  const key = new Map(rows.map((r) => [r.id, r.r2Key]));
  return assetIds.map((id) => key.get(id)).filter((k): k is string => Boolean(k));
}

/** Appends one ad_attestations row (the table refuses anything but inserts). */
export async function recordAttestation(args: {
  req: FastifyRequest;
  campaign: Campaign;
  action: Action;
  creativeId?: string | null;
  purchaseId?: string | null;
  assetKeys?: string[];
  /** Defaults to the two-tick text; the website tick passes its own. */
  version?: string;
  text?: string;
}): Promise<void> {
  await db.insert(adAttestations).values({
    campaignId: args.campaign.id,
    creativeId: args.creativeId ?? null,
    purchaseId: args.purchaseId ?? null,
    userId: args.req.userId!,
    action: args.action,
    attestationTextVersion: args.version ?? ATTESTATION_VERSION,
    exactTextSnapshot: args.text ?? attestationSnapshotText(),
    ipAddress: clientIp(args.req),
    userAgent: clientUserAgent(args.req),
    contentSnapshot: await contentSnapshot(args.campaign, { assetKeys: args.assetKeys }),
  });
}

/** The order-time attestation of a paid new-ad order, if one was recorded. */
export async function orderAttestation(purchaseId: string) {
  const [row] = await db
    .select()
    .from(adAttestations)
    .where(and(eq(adAttestations.purchaseId, purchaseId), eq(adAttestations.action, "order")))
    .orderBy(desc(adAttestations.createdAt))
    .limit(1);
  return row ?? null;
}

/** Every piece of ad text the REVIEW rules look at. */
/** The offer text of an "This month's offer" end slide (render_info.slide), if any. */
export function slideTexts(renderInfo: unknown): ComplianceText[] {
  const offer = (renderInfo as { slide?: { offer?: unknown } } | null | undefined)?.slide?.offer;
  return typeof offer === "string" && offer.trim() ? [{ field: "slide.offer", text: offer }] : [];
}

export function complianceTexts(
  campaign: Pick<Campaign, "name" | "businessName" | "callToAction" | "offerDetails">,
  scripts: unknown[],
): ComplianceText[] {
  const texts: ComplianceText[] = [
    { field: "offer", text: campaign.offerDetails },
    { field: "businessName", text: campaign.businessName },
    { field: "name", text: campaign.name },
    { field: "callToAction", text: campaign.callToAction },
  ];
  for (const raw of scripts) {
    const s = adScriptSchema.safeParse(raw);
    if (!s.success) continue;
    texts.push(
      { field: "script.hook", text: s.data.hook },
      { field: "script.body", text: s.data.scenes.map((sc) => sc.caption).join(" · ") },
      { field: "script.voiceover", text: s.data.voiceoverText },
      { field: "script.endCard", text: s.data.endCardText },
    );
    if (s.data.sticker) {
      const st = s.data.sticker;
      texts.push({ field: "script.sticker", text: [st.badge, st.headline, st.tagline, ...st.benefits].join(" · ") });
    }
  }
  return texts;
}

/**
 * Re-checks a campaign's text (row + its AdVault-made scripts) and stores the
 * result. Called after create, PATCH, PUT offer, generation and script edits.
 * Never throws: a failed re-check leaves the previous state.
 */
export async function reevaluateCompliance(campaignId: string): Promise<Campaign | null> {
  try {
    const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
    if (!campaign) return null;
    const scripts = await db
      .select({ script: creatives.script, renderInfo: creatives.renderInfo })
      .from(creatives)
      .where(eq(creatives.campaignId, campaignId));
    const found = reviewReasons(categoryKey(campaign.businessCategory), [
      ...complianceTexts(campaign, scripts.map((s) => s.script)),
      // An offer change on an uploaded video has no script: its offer lives
      // on the end slide (lib/offerSwap, render_info.slide).
      ...scripts.flatMap((s) => slideTexts(s.renderInfo)),
    ]);
    const next = nextCompliance(
      { status: campaign.complianceStatus, reasons: campaign.complianceReasons ?? null },
      found,
    );
    if (next.status === campaign.complianceStatus && JSON.stringify(next.reasons) === JSON.stringify(campaign.complianceReasons ?? null)) {
      return campaign;
    }
    const [updated] = await db
      .update(campaigns)
      .set({ complianceStatus: next.status, complianceReasons: next.reasons })
      .where(eq(campaigns.id, campaignId))
      .returning();
    return updated ?? campaign;
  } catch (err) {
    console.log(JSON.stringify({ job: "compliance", msg: "re-evaluate failed", extra: { campaignId, error: String(err) } }));
    return null;
  }
}

import { and, desc, eq, isNotNull, ne } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../auth/plugin.js";
import { db } from "../db/index.js";
import { campaigns, creatives } from "../db/schema.js";
import { decryptToken, encryptToken } from "../lib/crypto.js";
import { loadOwnedCampaign } from "../lib/ownership.js";
import {
  createSitevaultSite,
  offerBanner,
  sitevaultCategory,
  resolveSitevaultSite,
  servicesFromSticker,
  sitevaultConfigured,
  slugFromSiteUrl,
  taglineFromSticker,
  type Photo,
  type StickerLike,
  type Video,
} from "../lib/sitevault/index.js";
import { stickerSchema } from "../lib/script/schema.js";
import { getObjectBytes, headObject } from "../plugins/r2.js";
import { proPhotoKey } from "../render/enhance.js";
import { isHousingCategory } from "../lib/audience/policy.js";
import { latestSiteOffer } from "../lib/siteOffer/index.js";
import {
  feeDisplay,
  isPaidStatus,
  latestWebsitePurchase,
  publishPaidWebsiteSoon,
  startWebsiteCheckout,
  websiteFeeFor,
} from "../lib/websiteFee/index.js";

// "Make me a website" (2026-11-15). A business with no website can still make
// ads (PR #76) but needs a link to launch; this builds a one-page SiteVault
// site from the campaign (name, category, offer, the ad's photos, polished
// where we have them) plus the two facts AdVault doesn't collect (phone and
// town), and sets it as the campaign's website.

const PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_PHOTOS = 6;
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const IMAGE_EXT = /\.(jpe?g|png|webp)$/i;

const websiteInput = z.object({
  phone: z.string().trim().min(7).max(24),
  city: z.string().trim().min(2).max(60),
  hours: z.string().trim().max(400).optional(),
  // The address they chose (<slug>.3pandasite.com); SiteVault validates it.
  slug: z.string().trim().max(80).optional(),
  // The advertiser confirms they run the business: their site is public.
  attest: z.literal(true),
});

async function campaignPhotos(campaignId: string): Promise<Photo[]> {
  const rows = await db
    .select({ keys: creatives.sourceAssetKeys })
    .from(creatives)
    .where(and(eq(creatives.campaignId, campaignId), ne(creatives.kind, "upload")));
  const keys = [...new Set(rows.flatMap((r) => r.keys))].filter((k) => IMAGE_EXT.test(k)).slice(0, MAX_PHOTOS);
  const photos: Photo[] = [];
  for (const key of keys) {
    // The polished copy (photo-pro pass) when the renderer made one.
    const pro = proPhotoKey(campaignId, key);
    const proHead = await headObject(pro).catch(() => null);
    const useKey = proHead ? pro : key;
    const head = proHead ?? (await headObject(key).catch(() => null));
    const type = proHead ? "image/jpeg" : (head?.contentType ?? "");
    if (!head || !PHOTO_TYPES.has(type) || head.sizeBytes > MAX_PHOTO_BYTES) continue;
    photos.push({ bytes: await getObjectBytes(useKey), contentType: type });
  }
  return photos;
}

const MAX_VIDEO_BYTES = 40 * 1024 * 1024;

/**
 * The finished ad to show on the site, and its offer sticker. Widescreen
 * first (it sits in a page column); the vertical one when that is all there is.
 */
async function campaignAd(campaignId: string): Promise<{ video: Video | null; sticker: StickerLike | null }> {
  const rows = await db
    .select({
      aspectRatio: creatives.aspectRatio,
      videoKey: creatives.videoKey,
      sizeBytes: creatives.sizeBytes,
      script: creatives.script,
    })
    .from(creatives)
    .where(
      and(eq(creatives.campaignId, campaignId), ne(creatives.kind, "upload"), eq(creatives.renderStatus, "ready")),
    )
    .orderBy(desc(creatives.createdAt));
  const ad = rows.find((r) => r.aspectRatio === "16:9" && r.videoKey) ?? rows.find((r) => r.videoKey) ?? null;
  const parsed = stickerSchema.safeParse((rows[0]?.script as { sticker?: unknown } | null)?.sticker);
  const sticker = parsed.success ? parsed.data : null;
  if (!ad?.videoKey || (ad.sizeBytes ?? 0) > MAX_VIDEO_BYTES) return { video: null, sticker };
  try {
    const bytes = await getObjectBytes(ad.videoKey);
    return { video: bytes.length <= MAX_VIDEO_BYTES ? { bytes } : null, sticker };
  } catch {
    return { video: null, sticker };
  }
}

// One SiteVault website per AdVault account (one account = one business).
// A second campaign reuses the account's site instead of making another;
// SiteVault separately refuses a second live site for the same phone.

/** The account's existing SiteVault site (from any other campaign), or null. */
async function accountSite(userId: string, exceptCampaignId: string) {
  const [row] = await db
    .select({ landingUrl: campaigns.landingUrl, sitevaultEditEnc: campaigns.sitevaultEditEnc })
    .from(campaigns)
    .where(
      and(
        eq(campaigns.userId, userId),
        ne(campaigns.id, exceptCampaignId),
        isNotNull(campaigns.sitevaultEditEnc),
        isNotNull(campaigns.landingUrl),
      ),
    )
    .orderBy(desc(campaigns.updatedAt))
    .limit(1);
  if (!row?.landingUrl || !row.sitevaultEditEnc || !slugFromSiteUrl(row.landingUrl)) return null;
  // (A made-but-unpaid site elsewhere is caught by accountPendingSite.)
  // Its current address (it may have been renamed since).
  const current = (await resolveSitevaultSite(slugFromSiteUrl(row.landingUrl)!)) ?? row.landingUrl;
  return { siteUrl: current, sitevaultEditEnc: row.sitevaultEditEnc };
}

/** Another campaign of the account has a made-but-unpaid site (the $10 fee). */
async function accountPendingSite(userId: string, exceptCampaignId: string): Promise<string | null> {
  const [row] = await db
    .select({ url: campaigns.sitevaultPendingUrl })
    .from(campaigns)
    .where(and(eq(campaigns.userId, userId), ne(campaigns.id, exceptCampaignId), isNotNull(campaigns.sitevaultPendingUrl)))
    .limit(1);
  return row?.url ?? null;
}

export async function websiteRoutes(app: FastifyInstance) {
  app.addHook("onRequest", requireAuth);

  // Use the account's existing website for this campaign (one click).
  app.post(
    "/campaigns/:campaignId/website/use-existing",
    { schema: { params: z.object({ campaignId: z.string().uuid() }) } },
    async (req, reply) => {
      const { campaignId } = req.params as { campaignId: string };
      const campaign = await loadOwnedCampaign(campaignId, req.userId!, reply);
      if (!campaign) return;
      if (campaign.status === "live" || campaign.googleCampaignResourceName) {
        return reply.code(409).send({ error: "campaign_is_live" });
      }
      const existing = await accountSite(req.userId!, campaign.id);
      if (!existing) return reply.code(404).send({ error: "no_account_website" });
      const [updated] = await db
        .update(campaigns)
        .set({ landingUrl: existing.siteUrl, sitevaultEditEnc: existing.sitevaultEditEnc, updatedAt: new Date() })
        .where(eq(campaigns.id, campaign.id))
        .returning();
      return { campaign: updated, siteUrl: existing.siteUrl };
    },
  );

  app.post(
    "/campaigns/:campaignId/website",
    { schema: { params: z.object({ campaignId: z.string().uuid() }), body: websiteInput } },
    async (req, reply) => {
      const { campaignId } = req.params as { campaignId: string };
      const body = req.body as z.infer<typeof websiteInput>;
      const campaign = await loadOwnedCampaign(campaignId, req.userId!, reply);
      if (!campaign) return;
      if (campaign.status === "live" || campaign.googleCampaignResourceName) {
        return reply.code(409).send({ error: "campaign_is_live" });
      }
      if (campaign.landingUrl) return reply.code(409).send({ error: "website_exists" });
      if (campaign.sitevaultPendingUrl) return reply.code(409).send({ error: "website_payment_pending" });
      if (!sitevaultConfigured()) return reply.code(503).send({ error: "website_builder_not_configured" });
      const existing = await accountSite(req.userId!, campaign.id);
      if (existing) {
        return reply.code(409).send({ error: "website_exists_for_account", detail: existing.siteUrl });
      }
      const pendingElsewhere = await accountPendingSite(req.userId!, campaign.id);
      if (pendingElsewhere) return reply.code(409).send({ error: "website_exists_for_account", detail: pendingElsewhere });
      // $10 website fee (null for admins / at_cost: made and published at once, as before).
      const fee = await websiteFeeFor(req.userId!);

      const housing = isHousingCategory(campaign.businessCategory);
      const { video, sticker } = await campaignAd(campaign.id);
      const result = await createSitevaultSite(
        {
          businessName: campaign.businessName,
          category: sitevaultCategory(campaign.businessCategory),
          phone: body.phone,
          city: body.city,
          offer: offerBanner(campaign.offerDetails),
          serviceArea: housing ? undefined : `Within ${campaign.radiusMiles} miles of ${body.city}`,
          hours: body.hours,
          services: servicesFromSticker(sticker),
          tagline: taglineFromSticker(sticker),
          slug: body.slug || undefined,
          awaitingPayment: fee ? "1" : undefined,
        },
        await campaignPhotos(campaign.id),
        video,
      );
      if (!result.ok) {
        req.log.warn({ campaignId, status: result.status, errors: result.errors }, "sitevault create failed");
        return reply
          .code(result.status === 400 ? 400 : 502)
          .send({
            error: result.status === 400 ? "website_invalid" : "website_builder_failed",
            detail: Object.values(result.errors)[0],
            errors: result.errors,
          });
      }

      if (fee) {
        // Made, unpublished: it becomes the link once the $10 is paid (lib/websiteFee).
        const [updated] = await db
          .update(campaigns)
          .set({ sitevaultPendingUrl: result.siteUrl, sitevaultEditEnc: encryptToken(result.editUrl), updatedAt: new Date() })
          .where(eq(campaigns.id, campaign.id))
          .returning();
        req.log.info({ campaignId, slug: result.slug }, "sitevault site created, awaiting the website fee");
        let checkout = null;
        try {
          checkout = (await startWebsiteCheckout({ userId: req.userId!, campaignId: campaign.id, slug: result.slug, fee })).checkout;
        } catch (err) {
          // The site is kept; the card's "Pay and publish" retries the checkout.
          req.log.error({ err, campaignId }, "website checkout failed");
        }
        return reply.code(201).send({
          campaign: updated,
          siteUrl: null,
          editUrl: result.editUrl,
          pendingSite: { siteUrl: result.siteUrl, paid: false, display: feeDisplay(fee) },
          checkout,
        });
      }
      const [updated] = await db
        .update(campaigns)
        .set({ landingUrl: result.siteUrl, sitevaultEditEnc: encryptToken(result.editUrl), updatedAt: new Date() })
        .where(eq(campaigns.id, campaign.id))
        .returning();
      req.log.info({ campaignId, slug: result.slug }, "sitevault site created");
      return reply.code(201).send({ campaign: updated, siteUrl: result.siteUrl, editUrl: result.editUrl });
    },
  );

  // Pay (again) for a made-but-unpaid site: a new checkout, e.g. after an abandoned one.
  app.post(
    "/campaigns/:campaignId/website/checkout",
    { schema: { params: z.object({ campaignId: z.string().uuid() }) } },
    async (req, reply) => {
      const { campaignId } = req.params as { campaignId: string };
      const campaign = await loadOwnedCampaign(campaignId, req.userId!, reply);
      if (!campaign) return;
      const slug = slugFromSiteUrl(campaign.sitevaultPendingUrl);
      if (!campaign.sitevaultPendingUrl || !slug) return reply.code(409).send({ error: "no_pending_website" });
      const last = await latestWebsitePurchase(campaign.id);
      if (last && isPaidStatus(last.status)) {
        publishPaidWebsiteSoon(last.id);
        return reply.code(409).send({ error: "website_already_paid" });
      }
      const fee = await websiteFeeFor(req.userId!);
      if (!fee) return reply.code(409).send({ error: "website_fee_not_applicable" });
      const { checkout } = await startWebsiteCheckout({ userId: req.userId!, campaignId: campaign.id, slug, fee });
      return reply.code(201).send({ checkout });
    },
  );

  // The private edit link, for the owner only (decrypted on request).
  app.get(
    "/campaigns/:campaignId/website",
    { schema: { params: z.object({ campaignId: z.string().uuid() }) } },
    async (req, reply) => {
      const { campaignId } = req.params as { campaignId: string };
      const campaign = await loadOwnedCampaign(campaignId, req.userId!, reply);
      if (!campaign) return;
      let editUrl: string | null = null;
      if (campaign.sitevaultEditEnc) {
        try {
          editUrl = decryptToken(campaign.sitevaultEditEnc);
        } catch {
          editUrl = null;
        }
      }
      // Made but unpaid ($10 website fee): the card offers "Pay and publish".
      if (campaign.sitevaultPendingUrl && !campaign.landingUrl) {
        const last = await latestWebsitePurchase(campaign.id);
        const paid = Boolean(last && isPaidStatus(last.status));
        if (paid && last) publishPaidWebsiteSoon(last.id); // nudge a stuck publish along
        const fee = await websiteFeeFor(req.userId!);
        return {
          siteUrl: null,
          editUrl,
          pendingSite: { siteUrl: campaign.sitevaultPendingUrl, paid, display: fee ? feeDisplay(fee) : null },
        };
      }
      // Follow a rename made on SiteVault's edit page (or the move from the
      // old /s/ links to 3pandasite.com), so the ad's link never lands on a
      // redirect. Only before launch: a live campaign's link is Google's.
      const slug = slugFromSiteUrl(campaign.landingUrl);
      const locked = campaign.status === "live" || Boolean(campaign.googleCampaignResourceName);
      if (slug && !locked) {
        const current = await resolveSitevaultSite(slug);
        if (current && current !== campaign.landingUrl) {
          const [updated] = await db
            .update(campaigns)
            .set({ landingUrl: current, updatedAt: new Date() })
            .where(eq(campaigns.id, campaign.id))
            .returning();
          req.log.info({ campaignId, from: campaign.landingUrl, to: current }, "website link followed sitevault rename");
          return { siteUrl: current, editUrl, campaign: updated, siteOffer: await latestSiteOffer(campaign.id) };
        }
      }
      // No website yet, but the account already has one: offer that instead
      // of making a second site for the same business.
      if (!campaign.landingUrl && !locked) {
        const existing = await accountSite(req.userId!, campaign.id);
        if (existing) return { siteUrl: null, editUrl, accountSite: { siteUrl: existing.siteUrl } };
        // What "Make me a website" costs (null = free: admins, at_cost).
        const fee = await websiteFeeFor(req.userId!);
        return { siteUrl: null, editUrl, websiteFee: fee ? feeDisplay(fee) : null };
      }
      // Offer combo: did the latest paid website offer reach the site?
      return { siteUrl: campaign.landingUrl, editUrl, siteOffer: await latestSiteOffer(campaign.id) };
    },
  );
}

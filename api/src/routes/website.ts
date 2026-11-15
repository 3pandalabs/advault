import { and, desc, eq, ne } from "drizzle-orm";
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
  servicesFromSticker,
  sitevaultConfigured,
  taglineFromSticker,
  type Photo,
  type StickerLike,
  type Video,
} from "../lib/sitevault/index.js";
import { stickerSchema } from "../lib/script/schema.js";
import { getObjectBytes, headObject } from "../plugins/r2.js";
import { proPhotoKey } from "../render/enhance.js";
import { isHousingCategory } from "../lib/audience/policy.js";

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

export async function websiteRoutes(app: FastifyInstance) {
  app.addHook("onRequest", requireAuth);

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
      if (!sitevaultConfigured()) return reply.code(503).send({ error: "website_builder_not_configured" });

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

      const [updated] = await db
        .update(campaigns)
        .set({ landingUrl: result.siteUrl, sitevaultEditEnc: encryptToken(result.editUrl), updatedAt: new Date() })
        .where(eq(campaigns.id, campaign.id))
        .returning();
      req.log.info({ campaignId, slug: result.slug }, "sitevault site created");
      return reply.code(201).send({ campaign: updated, siteUrl: result.siteUrl, editUrl: result.editUrl });
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
      return { siteUrl: campaign.landingUrl, editUrl };
    },
  );
}

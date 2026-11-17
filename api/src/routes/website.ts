import { ownVideoForNewSite } from "../lib/siteVideo/index.js";
import { and, desc, eq, inArray, isNotNull, isNull, ne } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAdmin, requireAuth } from "../auth/plugin.js";
import { db } from "../db/index.js";
import { assets, campaigns, creatives, purchases, users } from "../db/schema.js";
import { beforeAfterAllowed, pairAssetIds } from "../lib/beforeAfter/policy.js";
import { decryptToken, encryptToken } from "../lib/crypto.js";
import { loadOwnedCampaign } from "../lib/ownership.js";
import {
  createSitevaultSite,
  deleteSitevaultSite,
  fetchAccountSitevaultSite,
  offerBanner,
  sitevaultSignInEditUrl,
  sitevaultStateIsLive,
  sitevaultCategory,
  resolveSitevaultSite,
  setSitevaultOwner,
  servicesFromSticker,
  sitevaultConfigured,
  slugFromSiteUrl,
  taglineFromSticker,
  type BeforeAfterPhotos,
  type Photo,
  type StickerLike,
} from "../lib/sitevault/index.js";
import { stickerSchema } from "../lib/script/schema.js";
import { markAppUsed } from "../lib/sharedAccount/index.js";
import { getObjectBytes, headObject } from "../plugins/r2.js";
import { proPhotoKey } from "../render/enhance.js";
import { isHousingCategory } from "../lib/audience/policy.js";
import { fetchSiteOfferStatus, latestSiteOffer } from "../lib/siteOffer/index.js";
import { billingIdentity } from "../lib/testMode/index.js";
import { SITE_OFFER_MAX_ATTEMPTS } from "../lib/siteOffer/policy.js";
import {
  WEBSITE_FEE_MAX_ATTEMPTS,
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

/**
 * The campaign's before & after pairs (lib/beforeAfter) for the site: the
 * ORIGINAL photos, never a polished copy (both halves stay as taken). A pair
 * with a missing, oversized or non-image half is left out whole.
 */
async function campaignBeforeAfter(campaign: typeof campaigns.$inferSelect): Promise<BeforeAfterPhotos[]> {
  if (!beforeAfterAllowed(campaign.businessCategory)) return [];
  const pairs = campaign.beforeAfter ?? [];
  const ids = pairAssetIds(pairs);
  if (ids.length === 0) return [];
  const rows = await db
    .select({ id: assets.id, r2Key: assets.r2Key })
    .from(assets)
    .where(and(eq(assets.userId, campaign.userId), inArray(assets.id, ids)));
  const keyOf = new Map(rows.map((r) => [r.id, r.r2Key]));
  const load = async (id: string): Promise<Photo | null> => {
    const key = keyOf.get(id);
    if (!key || !IMAGE_EXT.test(key)) return null;
    const head = await headObject(key).catch(() => null);
    if (!head || !PHOTO_TYPES.has(head.contentType ?? "") || head.sizeBytes > MAX_PHOTO_BYTES) return null;
    return { bytes: await getObjectBytes(key), contentType: head.contentType! };
  };
  const out: BeforeAfterPhotos[] = [];
  for (const p of pairs) {
    const before = await load(p.beforeAssetId).catch(() => null);
    const after = await load(p.afterAssetId).catch(() => null);
    if (before && after) out.push({ before, after });
  }
  return out;
}

/**
 * The ad's offer sticker (services and one-liner for the site). The ad VIDEO
 * is not sent here any more: it goes on the site at launch (lib/siteVideo).
 */
async function campaignAd(campaignId: string): Promise<{ sticker: StickerLike | null }> {
  const rows = await db
    .select({ script: creatives.script })
    .from(creatives)
    .where(
      and(eq(creatives.campaignId, campaignId), ne(creatives.kind, "upload"), eq(creatives.renderStatus, "ready")),
    )
    .orderBy(desc(creatives.createdAt));
  const parsed = stickerSchema.safeParse((rows[0]?.script as { sticker?: unknown } | null)?.sticker);
  return { sticker: parsed.success ? parsed.data : null };
}

// One SiteVault website per AdVault account (one account = one business).
// A second campaign reuses the account's site instead of making another;
// SiteVault separately refuses a second live site for the same phone, and a
// second site for the same shared account (409 account_has_site).

/**
 * Admins may make any number of websites (testing); everyone else gets one per
 * account. An admin testing as a customer gets the customer rule (lib/testMode).
 */
async function isAdminUser(userId: string): Promise<boolean> {
  return (await billingIdentity(userId)).role === "admin";
}

/**
 * The REAL role (users.role), never the test-mode one: "Delete it and make a
 * new one" is an admin tool, so "Test as customer" must not hide it.
 */
async function isRealAdmin(userId: string): Promise<boolean> {
  const [u] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId)).limit(1);
  return u?.role === "admin";
}

type AccountSite = {
  siteUrl: string;
  /** The encrypted edit link when AdVault made the site; null for one built on SiteVault. */
  sitevaultEditEnc: string | null;
  /** SiteVault's state for a site found there (null = from our own campaigns). */
  state: string | null;
};

/**
 * The account's existing SiteVault site, or null: first from its other
 * campaigns (AdVault made it), else from SiteVault itself, because the shared
 * 3PandaLabs account may have built one there (QA 2026-11-16). SiteVault down
 * or an older Worker without the lookup = null, i.e. the behaviour before it.
 */
async function accountSite(userId: string, exceptCampaignId: string): Promise<AccountSite | null> {
  return (await accountSiteFromCampaigns(userId, exceptCampaignId)) ?? (await accountSiteFromSitevault(userId));
}

async function accountSiteFromSitevault(userId: string): Promise<AccountSite | null> {
  const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
  const found = await fetchAccountSitevaultSite({ advaultUserId: userId, email: u?.email });
  if (!found) return null;
  // A site we made and are still waiting on the $10 for belongs to the
  // pending flow (pendingSite / accountPendingSite), not to "use existing".
  const pending = await db
    .select({ url: campaigns.sitevaultPendingUrl })
    .from(campaigns)
    .where(and(eq(campaigns.userId, userId), isNotNull(campaigns.sitevaultPendingUrl)));
  if (pending.some((p) => slugFromSiteUrl(p.url) === found.slug)) return null;
  return { siteUrl: found.siteUrl, sitevaultEditEnc: null, state: found.state };
}

async function accountSiteFromCampaigns(userId: string, exceptCampaignId: string): Promise<AccountSite | null> {
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
  return { siteUrl: current, sitevaultEditEnc: row.sitevaultEditEnc, state: null };
}

/** The edit link the card shows: the stored one, else SiteVault's sign-in edit page for a SiteVault link. */
function editLinkFor(stored: string | null, landingUrl: string | null | undefined): string | null {
  if (stored) return stored;
  const slug = slugFromSiteUrl(landingUrl);
  return slug ? sitevaultSignInEditUrl(slug) : null;
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

/**
 * The site an admin's "Delete it and make a new one" removes: the account's
 * website (the one the card offers), else a made-but-unpaid one on another
 * campaign (which blocks a new site just the same). Null = nothing to delete.
 */
async function adminDeletableSite(userId: string, exceptCampaignId: string): Promise<{ siteUrl: string; state: string | null } | null> {
  const existing = await accountSite(userId, exceptCampaignId);
  if (existing) return { siteUrl: existing.siteUrl, state: existing.state };
  const pending = await accountPendingSite(userId, exceptCampaignId);
  return pending ? { siteUrl: pending, state: "pending" } : null;
}

const deleteAccountSiteInput = z
  .object({
    // The link the card showed: refuse if the account's site changed meanwhile.
    siteUrl: z.string().trim().max(500).optional(),
  })
  .optional();

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
      // Built on SiteVault but not published there (unpaid plan, paused): an
      // ad must not send people to a hold page.
      if (existing.state !== null && !sitevaultStateIsLive(existing.state)) {
        return reply.code(409).send({ error: "account_website_not_live", detail: existing.siteUrl });
      }
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
      const admin = await isAdminUser(req.userId!);
      if (!admin) {
        const existing = await accountSite(req.userId!, campaign.id);
        if (existing) {
          return reply.code(409).send({ error: "website_exists_for_account", detail: existing.siteUrl });
        }
        const pendingElsewhere = await accountPendingSite(req.userId!, campaign.id);
        if (pendingElsewhere) return reply.code(409).send({ error: "website_exists_for_account", detail: pendingElsewhere });
      }
      // $10 website fee (null for admins / at_cost: made and published at once, as before).
      const fee = await websiteFeeFor(req.userId!);

      const [owner] = await db.select({ email: users.email }).from(users).where(eq(users.id, req.userId!)).limit(1);
      const housing = isHousingCategory(campaign.businessCategory);
      const { sticker } = await campaignAd(campaign.id);
      const photos = await campaignPhotos(campaign.id);
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
          // Same login on SiteVault: the site goes to this AdVault user's account.
          ownerAdvaultUserId: req.userId!,
          ownerEmail: owner?.email,
          // Admin test site on SiteVault: no one-per-phone rule, never claims the number.
          ownerAdmin: admin ? "1" : undefined,
        },
        photos,
        // No photos means they used their own video: it goes on the site now
        // (approved uploads only). Generated ads still wait for launch.
        photos.length === 0 ? await ownVideoForNewSite(campaign.id) : null,
        // Optional before & after pairs (ba1Before... on SiteVault's side).
        await campaignBeforeAfter(campaign),
      );
      if (!result.ok && result.status === 409 && result.code === "account_has_site") {
        // SiteVault says the account already owns a site (our lookup missed
        // it, e.g. SiteVault was briefly unreachable). Nothing was made and
        // no $10 checkout is opened.
        return reply.code(409).send({ error: "website_exists_for_account", detail: result.siteUrl });
      }
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
      // Shared account: this account now has a SiteVault website (lib/sharedAccount).
      await markAppUsed(db, req.userId!, "sitevault").catch((err) => req.log.warn({ err }, "sitevault first-use stamp failed"));

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

  // Admin "Delete it and make a new one" (2026-11-17): deletes the account's
  // website on SiteVault for good (files, address, phone, account link) and
  // unlinks it here, so "Make me a website" builds a brand-new one. REAL
  // admins only (requireAdmin = JWT role, plus users.role), so "Test as
  // customer" can't hide it and customers can never call it. Refused while a
  // launched campaign links the site (Google's ad points at it).
  app.post(
    "/campaigns/:campaignId/website/account-site/delete",
    {
      preHandler: requireAdmin,
      schema: { params: z.object({ campaignId: z.string().uuid() }), body: deleteAccountSiteInput },
    },
    async (req, reply) => {
      if (!(await isRealAdmin(req.userId!))) return reply.code(403).send({ error: "admin_role_required" });
      const { campaignId } = req.params as { campaignId: string };
      const body = (req.body ?? {}) as NonNullable<z.infer<typeof deleteAccountSiteInput>>;
      const campaign = await loadOwnedCampaign(campaignId, req.userId!, reply);
      if (!campaign) return;
      if (campaign.status === "live" || campaign.googleCampaignResourceName) {
        return reply.code(409).send({ error: "campaign_is_live" });
      }
      const target = await adminDeletableSite(req.userId!, campaign.id);
      const slug = slugFromSiteUrl(target?.siteUrl);
      if (!target || !slug) return reply.code(404).send({ error: "no_account_website" });
      if (body.siteUrl && slugFromSiteUrl(body.siteUrl) !== slug) {
        return reply.code(409).send({ error: "account_website_changed", detail: target.siteUrl });
      }

      // Every address of this site our campaigns hold: its current one, plus
      // older ones (a rename on SiteVault) that resolve to it.
      const rows = await db
        .select({
          id: campaigns.id,
          name: campaigns.name,
          status: campaigns.status,
          googleCampaignResourceName: campaigns.googleCampaignResourceName,
          landingUrl: campaigns.landingUrl,
          sitevaultPendingUrl: campaigns.sitevaultPendingUrl,
        })
        .from(campaigns)
        .where(eq(campaigns.userId, req.userId!));
      const slugs = new Set([slug]);
      const others = new Set(
        rows
          .flatMap((r) => [slugFromSiteUrl(r.landingUrl), slugFromSiteUrl(r.sitevaultPendingUrl)])
          .filter((s): s is string => Boolean(s) && s !== slug),
      );
      for (const other of others) {
        const current = await resolveSitevaultSite(other);
        if (current && slugFromSiteUrl(current) === slug) slugs.add(other);
      }
      const links = (url: string | null) => {
        const s = slugFromSiteUrl(url);
        return Boolean(s && slugs.has(s));
      };
      const launched = rows.find((r) => (r.status === "live" || r.googleCampaignResourceName) && links(r.landingUrl));
      if (launched) return reply.code(409).send({ error: "website_in_use_by_launched_campaign", detail: launched.name });

      const [owner] = await db.select({ email: users.email }).from(users).where(eq(users.id, req.userId!)).limit(1);
      const result = await deleteSitevaultSite(slug, { advaultUserId: req.userId!, email: owner?.email });
      if (!result.ok) {
        req.log.warn({ campaignId, slug, error: result.error }, "sitevault delete failed");
        const known = result.error === "not_your_site" || result.error === "has_subscription";
        return reply
          .code(known ? 409 : 502)
          .send({ error: known ? `website_${result.error}` : "website_delete_failed", detail: result.error });
      }

      // Unlink it everywhere on this account (none of these is launched).
      const now = new Date();
      const linked = rows.filter((r) => links(r.landingUrl)).map((r) => r.id);
      const pending = rows.filter((r) => links(r.sitevaultPendingUrl)).map((r) => r.id);
      if (linked.length) {
        await db
          .update(campaigns)
          .set({
            landingUrl: null,
            sitevaultEditEnc: null,
            siteVideoWanted: false,
            siteVideoPushedAt: null,
            siteVideoAttempts: 0,
            siteVideoError: null,
            updatedAt: now,
          })
          .where(inArray(campaigns.id, linked));
      }
      if (pending.length) {
        await db
          .update(campaigns)
          .set({ sitevaultPendingUrl: null, sitevaultEditEnc: null, updatedAt: now })
          .where(inArray(campaigns.id, pending));
      }
      // Stop sweeps that would push to the deleted address (a new site may
      // reuse it): an unpublished website fee and unpushed website offers.
      const gone = [...slugs];
      await db
        .update(purchases)
        .set({ websiteAttempts: WEBSITE_FEE_MAX_ATTEMPTS, websiteError: "site_deleted_by_admin", updatedAt: now })
        .where(and(eq(purchases.userId, req.userId!), inArray(purchases.websiteSlug, gone), isNull(purchases.websitePublishedAt)));
      await db
        .update(purchases)
        .set({ siteOfferAttempts: SITE_OFFER_MAX_ATTEMPTS, siteOfferError: "site_deleted_by_admin", updatedAt: now })
        .where(and(eq(purchases.userId, req.userId!), inArray(purchases.siteOfferSlug, gone), isNull(purchases.siteOfferPushedAt)));
      req.log.info({ campaignId, slug, addresses: gone.length, unlinked: linked.length + pending.length }, "admin deleted account website");
      return { deleted: result.deleted, slug: result.slug, unlinkedCampaigns: new Set([...linked, ...pending]).size };
    },
  );

  // Is the campaign's website actually up? The card shows a "building your
  // website" bar until it is, so the owner never opens a link that isn't
  // live yet. SiteVault must say live (or in grace) AND the page must load.
  // Not a SiteVault site = whatever they typed: ready.
  app.get(
    "/campaigns/:campaignId/website/ready",
    { schema: { params: z.object({ campaignId: z.string().uuid() }) } },
    async (req, reply) => {
      const { campaignId } = req.params as { campaignId: string };
      const campaign = await loadOwnedCampaign(campaignId, req.userId!, reply);
      if (!campaign) return;
      const url = campaign.landingUrl;
      const slug = slugFromSiteUrl(url);
      if (!url || !slug) return { ready: Boolean(url) };
      const status = await fetchSiteOfferStatus(slug);
      if (!status || (status.siteState !== "live" && status.siteState !== "grace")) return { ready: false };
      try {
        const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(6_000) });
        return { ready: res.ok };
      } catch {
        return { ready: false };
      }
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
      // Backfill: sites made before accounts join the owner's SiteVault account
      // (fire and forget; SiteVault never moves a site that already has an owner).
      const ownedSlug = slugFromSiteUrl(campaign.landingUrl) ?? slugFromSiteUrl(campaign.sitevaultPendingUrl);
      if (campaign.sitevaultEditEnc && ownedSlug) {
        void db.select({ email: users.email }).from(users).where(eq(users.id, req.userId!)).limit(1)
          .then(([u]) => (u ? setSitevaultOwner(ownedSlug, { advaultUserId: req.userId!, email: u.email }) : false))
          .catch(() => false);
      }
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
          return { siteUrl: current, editUrl: editLinkFor(editUrl, current), campaign: updated, siteOffer: await latestSiteOffer(campaign.id) };
        }
      }
      // No website yet, but the account already has one (made here for
      // another campaign, or built on SiteVault): offer that instead of making
      // a second site for the same business, and never quote the $10.
      if (!campaign.landingUrl && !locked) {
        // Admins (REAL role, test mode or not) also see the account's site,
        // with "Delete it and make a new one" (adminCanDelete). Outside test
        // mode they may still make another without deleting (adminCanMakeAnother).
        if (await isRealAdmin(req.userId!)) {
          const target = await adminDeletableSite(req.userId!, campaign.id);
          const actsAsAdmin = await isAdminUser(req.userId!);
          if (target) {
            return {
              siteUrl: null,
              editUrl,
              accountSite: target,
              adminCanDelete: true,
              adminCanMakeAnother: actsAsAdmin,
              ...(actsAsAdmin ? { websiteFee: null } : {}),
            };
          }
        } else {
          const existing = await accountSite(req.userId!, campaign.id);
          if (existing) return { siteUrl: null, editUrl, accountSite: { siteUrl: existing.siteUrl, state: existing.state } };
        }
        // What "Make me a website" costs (null = free: admins, at_cost).
        const fee = await websiteFeeFor(req.userId!);
        return { siteUrl: null, editUrl, websiteFee: fee ? feeDisplay(fee) : null };
      }
      // Offer combo: did the latest paid website offer reach the site?
      return { siteUrl: campaign.landingUrl, editUrl: editLinkFor(editUrl, campaign.landingUrl), siteOffer: await latestSiteOffer(campaign.id) };
    },
  );
}

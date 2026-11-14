import { and, desc, eq, inArray, ne, notInArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../auth/plugin.js";
import { db } from "../db/index.js";
import { assets, campaigns, creatives } from "../db/schema.js";
import { loadOwnedCampaign, loadOwnedCreative } from "../lib/ownership.js";
import { generateForCampaign } from "../lib/creatives/generate.js";
import { newAdGate, returnRender } from "../lib/newAd/index.js";
import { adScriptSchema } from "../lib/script/schema.js";
import { enqueueRender } from "../render/jobs.js";
import { campaignIdForCreativeKey, deleteObject, presignDownload } from "../plugins/r2.js";

const ASPECT_RATIOS = ["16:9", "9:16"] as const;

export async function creativeRoutes(app: FastifyInstance) {
  app.addHook("onRequest", requireAuth);

  // Step three of the wizard: write the scripts and queue the renders.
  //
  // Returns immediately with queued creatives rather than waiting on ffmpeg —
  // an encode takes ~30s per creative on a shared box, and holding an HTTP
  // request open for a minute is how you discover every proxy timeout between
  // the browser and the container. The dashboard polls GET /campaigns/:id.
  app.post(
    "/campaigns/:campaignId/creatives/generate",
    {
      schema: {
        params: z.object({ campaignId: z.string().uuid() }),
        body: z.object({
          assetIds: z.array(z.string().uuid()).min(1).max(5),
          peopleAssetIds: z.array(z.string().uuid()).max(5).optional(),
          portraitAssetId: z.string().uuid().nullish(),
          aspectRatios: z.array(z.enum(ASPECT_RATIOS)).min(1).max(2).default(["16:9", "9:16"]),
        }),
      },
    },
    async (req, reply) => {
      const { campaignId } = req.params as { campaignId: string };
      const body = req.body as {
        assetIds: string[];
        aspectRatios: ("16:9" | "9:16")[];
        peopleAssetIds?: string[];
        portraitAssetId?: string | null;
      };

      const campaign = await loadOwnedCampaign(campaignId, req.userId!, reply);
      if (!campaign) return;
      if (campaign.status === "live") {
        return reply.code(409).send({ error: "campaign_is_live" });
      }

      // Every ad is a paid one-off (lib/newAd). Generating again spends one of
      // the paid ad's redos; with none left this is a 402 for another $10 ad.
      const gate = await newAdGate(req.userId!, campaign.id);
      if (!gate.ok) return reply.code(402).send(gate.body);

      const result = await generateForCampaign({
        campaign,
        userId: req.userId!,
        assetIds: body.assetIds,
        peopleAssetIds: body.peopleAssetIds,
        portraitAssetId: body.portraitAssetId,
        aspectRatios: body.aspectRatios,
        warn: (msg, err) => req.log.warn({ err, campaignId }, msg),
      });
      if (!result.ok) {
        if (gate.renderFrom) await returnRender(gate.renderFrom);
        return reply.code(result.status).send(result.body);
      }
      return reply.code(202).send({ creatives: result.creatives });
    },
  );

  // "Make it again": a fresh script and render from the same photos, people
  // marks and formats as the campaign's current ad, replacing it (launch uses
  // every ready creative, so the old versions must go). Spends one of the paid
  // ad's redos (newAdGate); 402 new_ad_payment_required when none are left.
  app.post(
    "/campaigns/:campaignId/creatives/redo",
    { schema: { params: z.object({ campaignId: z.string().uuid() }) } },
    async (req, reply) => {
      const { campaignId } = req.params as { campaignId: string };
      const campaign = await loadOwnedCampaign(campaignId, req.userId!, reply);
      if (!campaign) return;
      if (campaign.status === "live") return reply.code(409).send({ error: "campaign_is_live" });

      const current = await db
        .select()
        .from(creatives)
        .where(and(eq(creatives.campaignId, campaign.id), ne(creatives.kind, "upload")))
        .orderBy(desc(creatives.createdAt));
      if (current.length === 0) return reply.code(409).send({ error: "nothing_to_redo" });
      if (current.some((c) => c.renderStatus === "queued" || c.renderStatus === "rendering")) {
        return reply.code(409).send({ error: "already_rendering" });
      }

      // The latest generation: same photos (keys -> this user's asset ids),
      // the people/portrait marks from its script, and its formats.
      const latest = current[0];
      const keys = latest.sourceAssetKeys;
      const owned = await db
        .select({ id: assets.id, r2Key: assets.r2Key })
        .from(assets)
        .where(and(eq(assets.userId, req.userId!), inArray(assets.r2Key, keys)));
      const idFor = new Map(owned.map((a) => [a.r2Key, a.id]));
      const assetIds = keys.map((k) => idFor.get(k)).filter((id): id is string => Boolean(id));
      if (assetIds.length === 0) return reply.code(409).send({ error: "photos_deleted" });
      const script = adScriptSchema.safeParse(latest.script);
      const marks = script.success ? script.data : null;
      const byIndex = (i: number) => (keys[i] ? idFor.get(keys[i]) : undefined);
      const aspectRatios = [
        ...new Set(current.filter((c) => c.sourceAssetKeys.join() === keys.join()).map((c) => c.aspectRatio)),
      ] as ("16:9" | "9:16")[];

      const gate = await newAdGate(req.userId!, campaign.id);
      if (!gate.ok) return reply.code(402).send(gate.body);

      const result = await generateForCampaign({
        campaign,
        userId: req.userId!,
        assetIds,
        aspectRatios,
        peopleAssetIds: (marks?.peopleIndexes ?? []).map(byIndex).filter((id): id is string => Boolean(id)),
        portraitAssetId: marks?.portraitIndex != null ? byIndex(marks.portraitIndex) ?? null : null,
        warn: (msg, err) => req.log.warn({ err, campaignId }, msg),
      });
      if (!result.ok) {
        if (gate.renderFrom) await returnRender(gate.renderFrom);
        return reply.code(result.status).send(result.body);
      }

      // Replace: drop the previous AdVault-made versions and their files.
      const keep = result.creatives.map((c) => c.id);
      const old = await db
        .delete(creatives)
        .where(and(eq(creatives.campaignId, campaign.id), ne(creatives.kind, "upload"), notInArray(creatives.id, keep)))
        .returning({ videoKey: creatives.videoKey, thumbnailKey: creatives.thumbnailKey });
      await Promise.all(
        old.flatMap((o) => [o.videoKey, o.thumbnailKey]).filter((k): k is string => Boolean(k)).map((k) => deleteObject(k).catch(() => undefined)),
      );
      return reply.code(202).send({ creatives: result.creatives });
    },
  );

  app.get(
    "/campaigns/:campaignId/creatives",
    { schema: { params: z.object({ campaignId: z.string().uuid() }) } },
    async (req, reply) => {
      const { campaignId } = req.params as { campaignId: string };
      if (!(await loadOwnedCampaign(campaignId, req.userId!, reply))) return;
      return db.select().from(creatives).where(eq(creatives.campaignId, campaignId));
    },
  );

  // Lets an advertiser fix the copy without regenerating. The script is
  // re-validated against the same schema the generator's output goes through,
  // so hand-edited text can't hand the renderer a 500-character caption or an
  // asset index that doesn't exist.
  app.patch(
    "/creatives/:creativeId/script",
    {
      schema: {
        params: z.object({ creativeId: z.string().uuid() }),
        body: z.object({ script: adScriptSchema }),
      },
    },
    async (req, reply) => {
      const { creativeId } = req.params as { creativeId: string };
      const owned = await loadOwnedCreative(creativeId, req.userId!, reply);
      if (!owned) return;

      // An uploaded video has no script or photos to render from; re-rendering
      // would overwrite the uploaded MP4 with an empty slideshow.
      if (owned.creative.kind === "upload") {
        return reply.code(409).send({
          error: "creative_is_upload",
          detail: "This video was uploaded, not made by AdVault, so it cannot be edited. Upload a new version instead.",
        });
      }

      // A creative that is already an ad at Google cannot be edited in place.
      // The ad references a YouTube video asset, and re-rendering would produce
      // a different video that the live ad does not point at — so the edit
      // would appear to work while the ad kept showing the old cut. Replacing a
      // live ad is a different operation and is not built yet; refusing is the
      // honest answer, and 409 says it is a state problem rather than a bad
      // request.
      if (owned.creative.googleAdResourceName) {
        return reply.code(409).send({
          error: "creative_is_live",
          detail:
            "This ad is already running at Google. Pause the campaign and make a new ad rather than editing this one.",
        });
      }

      const { script } = req.body as { script: z.infer<typeof adScriptSchema> };
      const maxIndex = Math.max(owned.creative.sourceAssetKeys.length - 1, 0);
      if (script.scenes.some((s) => s.assetIndex > maxIndex)) {
        return reply.code(400).send({ error: "asset_index_out_of_range" });
      }

      // A re-render costs vendor money, so it spends one of the paid ad's redos.
      const gate = await newAdGate(req.userId!, owned.creative.campaignId);
      if (!gate.ok) return reply.code(402).send(gate.body);

      const [updated] = await db
        .update(creatives)
        .set({
          script,
          scriptSource: "manual",
          renderStatus: "queued",
          renderError: null,
          // The published video is about to be superseded by a different cut,
          // so the creative is no longer published. Cleared here rather than
          // left stale, because a non-null id makes the upload worker skip the
          // re-publish entirely and the advertiser would get their old video.
          youtubeVideoId: null,
          youtubeUploadStatus: "pending",
          youtubeUploadError: null,
          youtubeChannelSource: null,
        })
        .where(eq(creatives.id, creativeId))
        .returning();

      await enqueueRender(creativeId);
      return reply.code(202).send(updated);
    },
  );

  // Re-queue a failed render. Cheap to offer and it is the right answer for
  // the common failure — a transient R2 or ffmpeg hiccup on one of the two
  // creatives while the other rendered fine.
  app.post(
    "/creatives/:creativeId/retry",
    { schema: { params: z.object({ creativeId: z.string().uuid() }) } },
    async (req, reply) => {
      const { creativeId } = req.params as { creativeId: string };
      const owned = await loadOwnedCreative(creativeId, req.userId!, reply);
      if (!owned) return;

      // An uploaded video has no script or photos to render from; re-rendering
      // would overwrite the uploaded MP4 with an empty slideshow.
      if (owned.creative.kind === "upload") {
        return reply.code(409).send({
          error: "creative_is_upload",
          detail: "This video was uploaded, not made by AdVault, so it cannot be re-rendered. Upload a new version instead.",
        });
      }
      if (owned.creative.renderStatus === "rendering") {
        return reply.code(409).send({ error: "already_rendering" });
      }
      // Free, so only for a render that actually failed: retrying a finished
      // one would be an unlimited free re-render (vendor money per render).
      // Changing a finished ad goes through the script edit, which is metered.
      if (owned.creative.renderStatus !== "failed") {
        return reply.code(409).send({ error: "not_failed" });
      }

      // Same reasoning as the edit route: a live ad points at a specific
      // YouTube video, and re-rendering would leave it pointing at the old one.
      if (owned.creative.googleAdResourceName) {
        return reply.code(409).send({
          error: "creative_is_live",
          detail:
            "This ad is already running at Google. Pause the campaign and make a new ad rather than re-rendering this one.",
        });
      }

      await db
        .update(creatives)
        .set({
          renderStatus: "queued",
          renderError: null,
          youtubeVideoId: null,
          youtubeUploadStatus: "pending",
          youtubeUploadError: null,
          youtubeChannelSource: null,
        })
        .where(eq(creatives.id, creativeId));
      await enqueueRender(creativeId);

      return reply.code(202).send({ ok: true });
    },
  );

  // Short-lived URL for the rendered MP4 or its poster frame — used by the
  // dashboard's preview player and the download button. Authorized by the
  // key's campaign prefix, so a caller can only reach their own campaigns'
  // objects even if they guess a key.
  app.post(
    "/creatives/download-url",
    { schema: { body: z.object({ key: z.string().min(1).max(300) }) } },
    async (req, reply) => {
      const { key } = req.body as { key: string };
      const campaignId = campaignIdForCreativeKey(key);
      if (!campaignId) return reply.code(400).send({ error: "invalid_key" });
      if (!(await loadOwnedCampaign(campaignId, req.userId!, reply))) return;

      return { url: await presignDownload(key) };
    },
  );
}

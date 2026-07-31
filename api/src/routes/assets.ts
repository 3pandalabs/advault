import { desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../auth/plugin.js";
import { db } from "../db/index.js";
import { assets } from "../db/schema.js";
import { loadOwnedAsset } from "../lib/ownership.js";
import {
  assetKey,
  deleteObject,
  extForType,
  isAllowedImageType,
  presignDownload,
  presignUpload,
  userIdForAssetKey,
} from "../plugins/r2.js";

// Storefront photos and logos. Two-step upload throughout: the API issues a
// presigned PUT and the browser uploads straight to R2, so a 10MB phone photo
// never occupies a Fastify worker for the duration of a mobile upload.

const MAX_ASSET_BYTES = 15 * 1024 * 1024;

export async function assetRoutes(app: FastifyInstance) {
  app.addHook("onRequest", requireAuth);

  // The key is generated server-side from the caller's own user id, never
  // accepted from the client. A client-supplied key is a write primitive over
  // the whole bucket no matter how carefully it is validated afterwards.
  app.post(
    "/assets/presign-upload",
    {
      schema: {
        body: z.object({
          contentType: z.string().max(100),
          kind: z.enum(["photo", "logo"]).default("photo"),
        }),
      },
    },
    async (req, reply) => {
      const { contentType } = req.body as { contentType: string };
      if (!isAllowedImageType(contentType)) {
        return reply.code(400).send({ error: "unsupported_content_type" });
      }

      const key = assetKey(req.userId!, extForType(contentType));
      return { key, uploadUrl: await presignUpload(key, contentType) };
    },
  );

  // Called after the browser's PUT succeeds. The row is created here rather
  // than at presign time so a presign the advertiser abandoned doesn't leave a
  // metadata row pointing at an object that was never uploaded.
  app.post(
    "/assets",
    {
      schema: {
        body: z.object({
          key: z.string().min(1).max(300),
          contentType: z.string().max(100),
          kind: z.enum(["photo", "logo"]).default("photo"),
          sizeBytes: z.number().int().positive().max(MAX_ASSET_BYTES).optional(),
          originalFilename: z.string().max(255).optional(),
        }),
      },
    },
    async (req, reply) => {
      const body = req.body as {
        key: string;
        contentType: string;
        kind: "photo" | "logo";
        sizeBytes?: number;
        originalFilename?: string;
      };

      // The key must be one this API minted for THIS user. Without the prefix
      // check a caller could register a row pointing at another advertiser's
      // object and then read it back through presign-download.
      if (userIdForAssetKey(body.key) !== req.userId) {
        return reply.code(400).send({ error: "invalid_key" });
      }
      if (!isAllowedImageType(body.contentType)) {
        return reply.code(400).send({ error: "unsupported_content_type" });
      }

      const [asset] = await db
        .insert(assets)
        .values({
          userId: req.userId!,
          kind: body.kind,
          r2Key: body.key,
          contentType: body.contentType,
          sizeBytes: body.sizeBytes,
          originalFilename: body.originalFilename,
        })
        .returning();

      return reply.code(201).send(asset);
    },
  );

  app.get("/assets", async (req) => {
    return db
      .select()
      .from(assets)
      .where(eq(assets.userId, req.userId!))
      .orderBy(desc(assets.createdAt));
  });

  // Short-lived read URL so the wizard can show thumbnails. Authorized by the
  // key's user prefix, so a caller can only mint a URL for their own objects.
  app.post(
    "/assets/presign-download",
    { schema: { body: z.object({ key: z.string().min(1).max(300) }) } },
    async (req, reply) => {
      const { key } = req.body as { key: string };
      if (userIdForAssetKey(key) !== req.userId) {
        return reply.code(400).send({ error: "invalid_key" });
      }
      return { url: await presignDownload(key) };
    },
  );

  app.delete(
    "/assets/:assetId",
    { schema: { params: z.object({ assetId: z.string().uuid() }) } },
    async (req, reply) => {
      const { assetId } = req.params as { assetId: string };
      const asset = await loadOwnedAsset(assetId, req.userId!, reply);
      if (!asset) return;

      await db.delete(assets).where(eq(assets.id, assetId));
      // Best-effort, and after the row is gone: an object that outlives its
      // metadata is invisible clutter, but a row pointing at a deleted object
      // is a broken thumbnail in the advertiser's face. Already-rendered
      // creatives are unaffected — they snapshot their source keys at
      // generation time and their MP4s live under a different prefix.
      await deleteObject(asset.r2Key).catch((err) =>
        req.log.warn({ err, key: asset.r2Key }, "failed to delete R2 object"),
      );

      return reply.code(204).send();
    },
  );
}

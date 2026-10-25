import { and, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../auth/plugin.js";
import { db } from "../db/index.js";
import { campaigns, creatives, youtubeChannels } from "../db/schema.js";
import { decryptToken, encryptToken } from "../lib/crypto.js";
import { exchangeCodeForTokens, revokeRefreshToken } from "../lib/googleAds/oauth.js";
import { issueOAuthState, verifyOAuthState } from "../lib/googleAds/oauthState.js";
import {
  isOrgChannelConfigured,
  isYouTubeOAuthConfigured,
  YOUTUBE_ORG_CHANNEL_TITLE,
} from "../lib/youtube/env.js";
import { buildYouTubeAuthorizeUrl, fetchOwnChannel } from "../lib/youtube/oauth.js";
import { enqueueYoutubeUpload } from "../render/youtubeJobs.js";

// Where a rendered ad goes before it can be an ad.
//
// Two shapes, and the default matters more than the option: with no channel of
// their own, an advertiser's ads go to the 3PandaLabs channel and they are
// never asked about it. That is the only thing that works for the managed
// Option A funnel, where the advertiser has no YouTube channel and asking them
// to make one mid-signup is a step this product cannot afford.
//
// Connecting their own channel is an upgrade offered in Settings. It changes
// where FUTURE uploads land; it does not move anything already published,
// because moving a video between channels is not something YouTube supports —
// a re-upload is a new video id and a new ad.

export async function youtubeRoutes(app: FastifyInstance) {
  app.addHook("onRequest", requireAuth);

  // What Settings renders. Says which channel is in effect and why, including
  // the case that matters most: neither credential configured, so every ad
  // renders fine and no campaign can ever serve.
  app.get("/youtube/channel", async (req) => {
    const [own] = await db
      .select({
        channelId: youtubeChannels.channelId,
        title: youtubeChannels.title,
        status: youtubeChannels.status,
        connectedAt: youtubeChannels.connectedAt,
      })
      .from(youtubeChannels)
      .where(eq(youtubeChannels.userId, req.userId!))
      .limit(1);

    return {
      // 'advertiser' only when the grant still works — a revoked one falls back
      // to the org channel, so reporting it as active would be a lie.
      effectiveSource: own && own.status === "active" ? "advertiser" : "org",
      ownChannel: own ?? null,
      canConnectOwnChannel: isYouTubeOAuthConfigured(),
      orgChannelConfigured: isOrgChannelConfigured(),
      orgChannelTitle: YOUTUBE_ORG_CHANNEL_TITLE,
      // The honest answer to "can my ads actually run". False means uploads
      // queue up and no launch can succeed.
      uploadsPossible: isOrgChannelConfigured() || own?.status === "active",
    };
  });

  // Step one. Built server-side so the client id and the exact redirect URI
  // live in one place — Google compares the whole redirect string.
  app.get("/youtube/authorize-url", async (req, reply) => {
    if (!isYouTubeOAuthConfigured()) {
      return reply.code(503).send({ error: "youtube_not_configured" });
    }
    // Same signed, single-use, user-bound state as the Ads flow. Without it
    // the callback attaches an attacker's channel to a victim's login, and
    // every ad the victim produces afterwards gets published there.
    return { url: buildYouTubeAuthorizeUrl(issueOAuthState(req.userId!)) };
  });

  // Step two. The web app's /oauth/youtube/callback page forwards the code
  // here; the client secret must never reach a browser bundle.
  app.post(
    "/youtube/callback",
    {
      schema: {
        body: z.object({
          code: z.string().min(1).max(2000),
          state: z.string().min(1).max(500),
        }),
      },
    },
    async (req, reply) => {
      if (!isYouTubeOAuthConfigured()) {
        return reply.code(503).send({ error: "youtube_not_configured" });
      }

      const body = req.body as { code: string; state: string };

      // The state's user id is authoritative — NOT req.userId. A mismatch means
      // the callback is being replayed under a different session, which is the
      // attack the state parameter exists to stop.
      const stateUserId = verifyOAuthState(body.state);
      if (!stateUserId || stateUserId !== req.userId) {
        return reply.code(400).send({ error: "invalid_state" });
      }

      const tokens = await exchangeCodeForTokens(body.code).catch(() => null);
      if (!tokens) return reply.code(400).send({ error: "token_exchange_failed" });

      // Nothing to store and nothing to refresh with later. Fail loudly rather
      // than saving a connection that cannot survive the hour.
      if (!tokens.refresh_token) {
        return reply.code(400).send({ error: "no_refresh_token_returned" });
      }

      const channel = await fetchOwnChannel(tokens.access_token);
      if (!channel) {
        // A Google account is not a YouTube channel until someone creates one,
        // and local-business owners routinely have the former and not the
        // latter. The grant is useless, so it is not stored — and the org
        // channel already covers them, so this is a dead end rather than a
        // blocker. Revoke what we were just given instead of keeping it.
        await revokeRefreshToken(tokens.refresh_token);
        return reply.code(400).send({
          error: "no_youtube_channel",
          detail:
            "That Google account has no YouTube channel yet. Your ads will keep publishing to the 3PandaLabs channel, which needs nothing from you.",
        });
      }

      // Upsert on user_id: connecting a second channel replaces the first
      // rather than leaving two grants that uploads could land on either of.
      await db
        .insert(youtubeChannels)
        .values({
          userId: req.userId!,
          channelId: channel.channelId,
          title: channel.title,
          refreshTokenCiphertext: encryptToken(tokens.refresh_token),
          scope: tokens.scope ?? null,
          status: "active",
        })
        .onConflictDoUpdate({
          target: youtubeChannels.userId,
          set: {
            channelId: channel.channelId,
            title: channel.title,
            refreshTokenCiphertext: encryptToken(tokens.refresh_token),
            scope: tokens.scope ?? null,
            status: "active",
            connectedAt: new Date(),
          },
        });

      return {
        channel,
        // Said plainly, because the opposite is what an advertiser will assume:
        // ads already published stay where they are.
        note: "New ads will publish to your channel. Ads already published stay on the channel they were published to.",
      };
    },
  );

  app.delete("/youtube/channel", async (req, reply) => {
    const [own] = await db
      .select()
      .from(youtubeChannels)
      .where(eq(youtubeChannels.userId, req.userId!))
      .limit(1);

    if (!own) return reply.code(404).send({ error: "not_connected" });

    // Best effort, then delete locally regardless — leaving a disconnect
    // half-done because Google was briefly unreachable is worse than an
    // orphaned grant the advertiser can also revoke from their Google account.
    await revokeRefreshToken(decryptToken(own.refreshTokenCiphertext));
    await db.delete(youtubeChannels).where(eq(youtubeChannels.id, own.id));

    return { disconnected: true, falls_back_to: "org" };
  });

  // Retry, and the thing that makes a late connection useful: a creative
  // rendered before any channel existed can be published later without being
  // re-encoded. Also the manual path out of an exhausted upload job.
  app.post<{ Params: { creativeId: string } }>(
    "/creatives/:creativeId/youtube-upload",
    { schema: { params: z.object({ creativeId: z.string().uuid() }) } },
    async (req, reply) => {
      const { creativeId } = req.params;

      // Ownership through the campaign — creatives have no user_id of their
      // own, and an id-only lookup here would let any logged-in user republish
      // somebody else's ad to their channel.
      const [creative] = await db
        .select({
          id: creatives.id,
          renderStatus: creatives.renderStatus,
          youtubeVideoId: creatives.youtubeVideoId,
          uploadStatus: creatives.youtubeUploadStatus,
        })
        .from(creatives)
        .innerJoin(campaigns, eq(creatives.campaignId, campaigns.id))
        .where(and(eq(creatives.id, creativeId), eq(campaigns.userId, req.userId!)))
        .limit(1);

      if (!creative) return reply.code(404).send({ error: "not_found" });

      if (creative.renderStatus !== "ready") {
        return reply.code(409).send({ error: "not_rendered" });
      }

      // Already on YouTube. Re-uploading would mint a second video id, orphan
      // the first, and burn upload quota for no gain — the existing ad keeps
      // working. A deliberate republish is a re-render, not this.
      if (creative.youtubeVideoId) {
        return reply
          .code(409)
          .send({ error: "already_uploaded", youtubeVideoId: creative.youtubeVideoId });
      }

      if (creative.uploadStatus === "uploading") {
        return reply.code(409).send({ error: "upload_in_progress" });
      }

      await enqueueYoutubeUpload(creativeId);
      return { queued: true };
    },
  );

  // Bulk version of the above, for the case the whole feature exists to serve:
  // an advertiser connects their own channel in month three and wants the back
  // catalogue there. Only creatives that never reached YouTube are queued —
  // published ones stay where they are.
  app.post("/youtube/backfill", async (req) => {
    const pending = await db
      .select({ id: creatives.id })
      .from(creatives)
      .innerJoin(campaigns, eq(creatives.campaignId, campaigns.id))
      .where(
        and(
          eq(campaigns.userId, req.userId!),
          eq(creatives.renderStatus, "ready"),
          inArray(creatives.youtubeUploadStatus, ["pending", "failed"]),
        ),
      );

    const queued: string[] = [];
    for (const row of pending) {
      await enqueueYoutubeUpload(row.id);
      queued.push(row.id);
    }

    return { queued: queued.length, creativeIds: queued };
  });
}

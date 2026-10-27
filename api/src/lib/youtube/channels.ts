import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { youtubeChannels } from "../../db/schema.js";
import { decryptToken } from "../crypto.js";
import { GoogleOAuthError, refreshAccessToken } from "../googleAds/oauth.js";
import { isOrgChannelConfigured, orgRefreshTokenCiphertext } from "./env.js";

export type ChannelSource = "org" | "advertiser";

export type UploadCredential = {
  accessToken: string;
  source: ChannelSource;
  /** Null for the org channel, whose id is configuration rather than a row. */
  channelId: string | null;
};

export class NoUploadChannel extends Error {
  constructor() {
    super("youtube_no_upload_channel");
  }
}

/**
 * Resolves which channel a creative belongs on and mints a token for it.
 *
 * Advertiser's own channel wins when they have connected one; the org channel
 * is the default and the fallback. The precedence matters: an advertiser who
 * connects their channel expects *subsequent* ads to land there, and one who
 * never connects must never be asked to.
 */
export async function uploadCredentialFor(userId: string): Promise<UploadCredential> {
  const [own] = await db
    .select()
    .from(youtubeChannels)
    .where(eq(youtubeChannels.userId, userId))
    .limit(1);

  if (own && own.status === "active") {
    try {
      const accessToken = await refreshAccessToken(decryptToken(own.refreshTokenCiphertext));
      await db
        .update(youtubeChannels)
        .set({ lastUsedAt: new Date() })
        .where(eq(youtubeChannels.id, own.id));
      return { accessToken, source: "advertiser", channelId: own.channelId };
    } catch (err) {
      // invalid_grant is permanent — revoked from the Google account side, a
      // password change, or disuse expiry. Mark it and fall through to the org
      // channel rather than failing the upload: a broken grant is not the same
      // as the advertiser asking us to stop (an explicit disconnect DELETEs the
      // row, so the org channel is already the answer in that case), and the
      // alternative is an ad that silently never serves.
      if (err instanceof GoogleOAuthError && err.code === "invalid_grant") {
        await db
          .update(youtubeChannels)
          .set({ status: "revoked" })
          .where(eq(youtubeChannels.id, own.id));
      } else {
        // A transient refresh failure must NOT silently relocate someone's ad
        // to the org channel. Let the queue retry against their own channel.
        throw err;
      }
    }
  }

  if (!isOrgChannelConfigured()) throw new NoUploadChannel();

  return {
    accessToken: await refreshAccessToken(decryptToken(orgRefreshTokenCiphertext()!)),
    source: "org",
    channelId: null,
  };
}

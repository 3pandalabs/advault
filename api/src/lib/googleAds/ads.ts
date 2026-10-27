import { googleAdsCall } from "./client.js";

// Ad groups and ads — the half of a launch that was missing until now.
//
// Before this module, routes/launch.ts created a budget, a campaign and geo
// targets and stopped. That is a campaign with nothing in it: Google accepts
// every call, the advertiser sees a real campaign in their account, and it can
// never show anything to anyone. Exactly the failure shape as the v1 missing
// fonts and the R2 checksum traps — a green path with a broken product at the
// end of it.
//
// The chain, in order, all of it required:
//   YouTube video id -> Asset (YOUTUBE_VIDEO) -> AdGroup -> AdGroupAd
//
// Nothing here spends money on its own; the campaign it hangs off is PAUSED.

type MutateResponse = { results?: { resourceName?: string }[] };

// ---------------------------------------------------------------------------
// Format choice.
//
// VideoResponsiveAdInfo — the obvious-looking choice — is NOT used, and the
// reason is worth recording so it doesn't get "fixed": it requires
// `business_name` AND `logo_images`, and a logo asset must be at least 128x128
// at a 1:1 aspect ratio. `assets.kind` does have a 'logo' value, but it is
// optional, nothing validates its dimensions or aspect ratio, and most
// advertisers upload storefront photos only. Using the responsive format would
// therefore mean making a square logo a MANDATORY, validated onboarding step in
// the exact funnel this product is trying to keep to three fields — and failing
// launches for everyone who had already signed up without one.
//
// VideoAdInfo's bumper and in-stream formats need the video and nothing else.
// ---------------------------------------------------------------------------

export type VideoAdFormat = "bumper" | "nonSkippable" | "inStream";

export type AdGroupType =
  | "VIDEO_BUMPER"
  | "VIDEO_NON_SKIPPABLE_IN_STREAM"
  | "VIDEO_TRUE_VIEW_IN_STREAM";

/**
 * Picks the ad format from the rendered duration, because Google enforces hard
 * length limits per format and rejects the mutate otherwise:
 *
 *  - bumper: 6 seconds or less, hard limit.
 *  - non-skippable in-stream: up to 15s, and up to 20s in some markets. 15 is
 *    used as the ceiling here — the markets where 20 is allowed are not
 *    enumerable from the API, and being wrong costs a rejected launch.
 *  - skippable in-stream (TrueView): any length, so it is the fallback for
 *    anything longer.
 *
 * The default pipeline renders ~13.5s, which lands on non-skippable.
 */
export function videoAdFormatFor(durationSeconds: number): {
  format: VideoAdFormat;
  adGroupType: AdGroupType;
} {
  if (durationSeconds <= 6) return { format: "bumper", adGroupType: "VIDEO_BUMPER" };
  if (durationSeconds <= 15) {
    return { format: "nonSkippable", adGroupType: "VIDEO_NON_SKIPPABLE_IN_STREAM" };
  }
  return { format: "inStream", adGroupType: "VIDEO_TRUE_VIEW_IN_STREAM" };
}

// ---------------------------------------------------------------------------
// The YouTube video, as a Google Ads asset.
// ---------------------------------------------------------------------------

/**
 * Finds or creates the YOUTUBE_VIDEO asset for a video id.
 *
 * Find-first rather than create-and-handle-the-error: assets are deduplicated
 * per customer by video id, so creating one twice is a failure rather than a
 * second asset, and a creative can legitimately be attached more than once —
 * a relaunch after a failed geo step, or a second campaign reusing an ad.
 */
export async function findOrCreateYoutubeVideoAsset(args: {
  accessToken: string;
  customerId: string;
  loginCustomerId?: string | null;
  youtubeVideoId: string;
  title: string;
}): Promise<string> {
  const existing = await googleAdsCall<{
    results?: { asset?: { resourceName?: string } }[];
  }>(`/customers/${args.customerId}/googleAds:search`, args.accessToken, {
    method: "POST",
    loginCustomerId: args.loginCustomerId,
    body: {
      query:
        "SELECT asset.resource_name FROM asset " +
        `WHERE asset.type = 'YOUTUBE_VIDEO' ` +
        `AND asset.youtube_video_asset.youtube_video_id = '${escapeGaql(args.youtubeVideoId)}' ` +
        "LIMIT 1",
    },
  });

  const found = existing.results?.[0]?.asset?.resourceName;
  if (found) return found;

  const body = await googleAdsCall<MutateResponse>(
    `/customers/${args.customerId}/assets:mutate`,
    args.accessToken,
    {
      method: "POST",
      loginCustomerId: args.loginCustomerId,
      body: {
        operations: [
          {
            create: {
              // Asset names must be unique within the account. The video id is
              // unique by construction and makes the asset traceable back to a
              // specific upload from the Google Ads UI.
              name: `AdVault ${args.youtubeVideoId}`,
              youtubeVideoAsset: {
                youtubeVideoId: args.youtubeVideoId,
                youtubeVideoTitle: args.title.slice(0, 100),
              },
            },
          },
        ],
      },
    },
  );

  const resourceName = body.results?.[0]?.resourceName;
  if (!resourceName) throw new Error("Google Ads returned no asset resource name");
  return resourceName;
}

// GAQL string literals take single quotes and have no parameter binding, so the
// one interpolated value in this file is escaped explicitly. A YouTube video id
// is 11 characters of [A-Za-z0-9_-] and cannot contain a quote — this guards
// against a malformed id reaching the query, not against a hostile one.
function escapeGaql(value: string): string {
  return value.replace(/['\\]/g, "");
}

// ---------------------------------------------------------------------------
// Ad group.
// ---------------------------------------------------------------------------

/**
 * One ad group per campaign. A target-frequency video campaign supports exactly
 * one, so this is created at launch and its resource name stored on the
 * campaign row.
 *
 * `type` is IMMUTABLE at Google: an ad group created for the wrong format
 * cannot be converted, only deleted and recreated. That is why the format is
 * derived from the creative's real rendered duration rather than assumed.
 *
 * No bid is set. The campaign carries targetCpm, and an ad-group-level bid
 * would override the campaign strategy for no reason anyone asked for.
 */
export async function createVideoAdGroup(args: {
  accessToken: string;
  customerId: string;
  loginCustomerId?: string | null;
  campaignResourceName: string;
  name: string;
  adGroupType: AdGroupType;
}): Promise<string> {
  const body = await googleAdsCall<MutateResponse>(
    `/customers/${args.customerId}/adGroups:mutate`,
    args.accessToken,
    {
      method: "POST",
      loginCustomerId: args.loginCustomerId,
      body: {
        operations: [
          {
            create: {
              name: args.name,
              campaign: args.campaignResourceName,
              type: args.adGroupType,
              // ENABLED, inside a PAUSED campaign. The campaign is the single
              // serving gate and the advertiser owns it; a paused ad group
              // would mean enabling the campaign still showed nothing, which
              // is the confusing failure this whole module exists to remove.
              status: "ENABLED",
            },
          },
        ],
      },
    },
  );

  const resourceName = body.results?.[0]?.resourceName;
  if (!resourceName) throw new Error("Google Ads returned no ad group resource name");
  return resourceName;
}

// ---------------------------------------------------------------------------
// The ad itself.
// ---------------------------------------------------------------------------

/**
 * Creates one video ad in the ad group.
 *
 * `finalUrl` is where a click goes and Google enforces that it is relevant to
 * the ad — it is the campaign's landing URL, which is required at campaign
 * creation precisely so this step always has one.
 */
export async function createVideoAd(args: {
  accessToken: string;
  customerId: string;
  loginCustomerId?: string | null;
  adGroupResourceName: string;
  videoAssetResourceName: string;
  finalUrl: string;
  format: VideoAdFormat;
  /** The campaign's call to action, e.g. "Call now". Max 10 characters at Google. */
  actionButtonLabel: string;
  /** Short line shown beside the button, e.g. the business name. */
  actionHeadline: string;
}): Promise<string> {
  // Google truncates nothing here — it rejects. 10 and 15 are the documented
  // limits for the CTA button label and the action headline.
  const actionButtonLabel = args.actionButtonLabel.slice(0, 10);
  const actionHeadline = args.actionHeadline.slice(0, 15);

  const formatInfo =
    args.format === "bumper"
      ? { bumper: { actionButtonLabel, actionHeadline } }
      : args.format === "nonSkippable"
        ? { nonSkippable: { actionButtonLabel, actionHeadline } }
        : { inStream: { actionButtonLabel, actionHeadline } };

  const body = await googleAdsCall<MutateResponse>(
    `/customers/${args.customerId}/adGroupAds:mutate`,
    args.accessToken,
    {
      method: "POST",
      loginCustomerId: args.loginCustomerId,
      body: {
        operations: [
          {
            create: {
              adGroup: args.adGroupResourceName,
              status: "ENABLED",
              ad: {
                finalUrls: [args.finalUrl],
                videoAd: {
                  video: { asset: args.videoAssetResourceName },
                  ...formatInfo,
                },
              },
            },
          },
        ],
      },
    },
  );

  const resourceName = body.results?.[0]?.resourceName;
  if (!resourceName) throw new Error("Google Ads returned no ad resource name");
  return resourceName;
}

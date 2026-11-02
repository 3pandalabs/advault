import { centsToMicros } from "./campaigns.js";
import { googleAdsCall } from "./client.js";

// ---------------------------------------------------------------------------
// The launch, as ONE atomic Google Ads request.
//
// ⚠️ WHY DEMAND GEN AND NOT A "VIDEO" CAMPAIGN. Until 2026-11-02 this app
// built an advertisingChannelType=VIDEO campaign. The Google Ads API cannot
// create those at all: it can read and report on Video campaigns, never
// create or change them (MUTATE_NOT_ALLOWED, trigger "VIDEO"). Every launch
// this app could ever have made would have failed at that call, and nothing
// noticed until the first real launch reached Google, because every earlier
// test stopped at a missing credential first.
//
// Demand Gen is the type Google points API users to instead, and it covers
// what AdVault sells: a video ad shown in YouTube in-stream, in-feed and
// Shorts, targeted to a set of postal codes.
//
// Everything — budget, campaign, ad group, locations, assets, ad — goes in a
// single GoogleAdsService.Mutate with temporary negative ids. Google applies
// all of it or none of it, so a failed launch leaves NOTHING behind in the
// advertiser's account. The previous five-call chain left an orphaned budget
// (and sometimes a campaign) every time a later step failed.
// ---------------------------------------------------------------------------

// Google rejects (never truncates) text over these limits. Demand Gen asset
// specs: https://support.google.com/google-ads/answer/13704860
export const TEXT_LIMITS = {
  businessName: 25,
  headline: 40,
  longHeadline: 90,
  description: 90,
} as const;

/** Most assets of one kind a Demand Gen video responsive ad accepts. */
const MAX_PER_KIND = 5;

/**
 * Fits text into a Google length limit without cutting a word in half.
 * Returns "" when nothing usable is left, so callers can drop it.
 */
export function fitText(input: string | null | undefined, max: number): string {
  const text = (input ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  // A single word longer than the limit is hard-cut rather than dropped.
  const trimmed = lastSpace > max * 0.5 ? cut.slice(0, lastSpace) : cut;
  return trimmed.replace(/[\s,;:\-–—.]+$/u, "").trim();
}

/** Fits, drops empties, de-duplicates case-insensitively, caps at Google's count. */
function textSet(candidates: (string | null | undefined)[], max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of candidates) {
    const t = fitText(c, max);
    const k = t.toLowerCase();
    if (!t || seen.has(k)) continue;
    seen.add(k);
    out.push(t);
    if (out.length === MAX_PER_KIND) break;
  }
  return out;
}

export type AdCopyInput = {
  businessName: string;
  businessCategory: string;
  callToAction: string;
  offerDetails?: string | null;
  /** The generated script of the first published creative, if any. */
  script?: { hook?: string; body?: string; cta?: string } | null;
};

export type AdCopy = {
  businessName: string;
  headlines: string[];
  longHeadlines: string[];
  descriptions: string[];
};

/**
 * Derives the ad's text from what the advertiser already gave us. No new
 * wizard fields: the script's hook and body were written for exactly this
 * business, and the plain fallbacks guarantee each list has at least one
 * entry — Google requires one of each.
 */
export function buildAdCopy(input: AdCopyInput): AdCopy {
  const category = input.businessCategory.trim();
  return {
    businessName:
      fitText(input.businessName, TEXT_LIMITS.businessName) || input.businessName.slice(0, 25),
    headlines: textSet(
      [input.script?.hook, input.businessName, input.callToAction, `Local ${category}`],
      TEXT_LIMITS.headline,
    ),
    longHeadlines: textSet(
      [input.script?.hook, input.offerDetails, `${input.businessName}: ${category} near you`],
      TEXT_LIMITS.longHeadline,
    ),
    descriptions: textSet(
      [
        input.script?.body,
        input.offerDetails,
        `${input.businessName}, your local ${category}. ${input.callToAction}.`,
      ],
      TEXT_LIMITS.description,
    ),
  };
}

// ---------------------------------------------------------------------------
// Existing assets. Google de-duplicates assets per account, so a video or
// logo that is already there is referenced rather than created again.
// ---------------------------------------------------------------------------

// GAQL has no parameter binding. The interpolated values are YouTube ids
// ([A-Za-z0-9_-]) and names this module builds from uuids, so this guards
// against a malformed value, not a hostile one.
function gaqlString(value: string): string {
  return value.replace(/['\\]/g, "");
}

async function findAsset(
  ctx: GoogleCtx,
  where: string,
): Promise<string | null> {
  const body = await googleAdsCall<{ results?: { asset?: { resourceName?: string } }[] }>(
    `/customers/${ctx.customerId}/googleAds:search`,
    ctx.accessToken,
    {
      method: "POST",
      loginCustomerId: ctx.loginCustomerId,
      body: { query: `SELECT asset.resource_name FROM asset WHERE ${where} LIMIT 1` },
    },
  );
  return body.results?.[0]?.asset?.resourceName ?? null;
}

export type GoogleCtx = {
  accessToken: string;
  customerId: string;
  loginCustomerId?: string | null;
};

export function findYoutubeVideoAsset(ctx: GoogleCtx, youtubeVideoId: string) {
  return findAsset(
    ctx,
    `asset.type = 'YOUTUBE_VIDEO' AND asset.youtube_video_asset.youtube_video_id = '${gaqlString(youtubeVideoId)}'`,
  );
}

export function logoAssetName(assetId: string): string {
  return `AdVault logo ${assetId}`;
}

export function findLogoAsset(ctx: GoogleCtx, assetId: string) {
  return findAsset(
    ctx,
    `asset.type = 'IMAGE' AND asset.name = '${gaqlString(logoAssetName(assetId))}'`,
  );
}

// ---------------------------------------------------------------------------
// The request body. Pure, so the shape Google receives is tested without a
// live account.
// ---------------------------------------------------------------------------

export type LaunchPlan = {
  customerId: string;
  /** Short, unique suffix for names Google requires to be unique per account. */
  nameSuffix: string;
  campaignName: string;
  dailyBudgetCents: number;
  finalUrl: string;
  geoTargetConstants: string[];
  copy: AdCopy;
  /** One per published creative: an existing asset, or a video to create. */
  videos: ({ existing: string } | { youtubeVideoId: string; title: string })[];
  logo: { existing: string } | { name: string; base64: string };
};

// Temp ids. Negative numbers are Google's convention for "created in this
// request"; each resource type has its own id space.
const BUDGET = -1;
const CAMPAIGN = -2;
const AD_GROUP = -3;

export function buildLaunchOperations(plan: LaunchPlan): unknown[] {
  if (plan.geoTargetConstants.length === 0) {
    // A Demand Gen ad group with no location criteria targets everywhere the
    // language matches — the single most expensive way for this app to be
    // wrong. Guarded here as well as in the route.
    throw new Error("Refusing to build a launch with no location targets");
  }
  if (plan.videos.length === 0) throw new Error("Refusing to build a launch with no video");

  const c = `customers/${plan.customerId}`;
  const budget = `${c}/campaignBudgets/${BUDGET}`;
  const campaign = `${c}/campaigns/${CAMPAIGN}`;
  const adGroup = `${c}/adGroups/${AD_GROUP}`;

  const ops: unknown[] = [];

  ops.push({
    campaignBudgetOperation: {
      create: {
        resourceName: budget,
        name: `${plan.campaignName} budget (${plan.nameSuffix})`,
        amountMicros: String(centsToMicros(plan.dailyBudgetCents)),
        deliveryMethod: "STANDARD",
        // Demand Gen refuses shared budgets, and a shared one could let one
        // advertiser's campaign draw down another's.
        explicitlyShared: false,
      },
    },
  });

  ops.push({
    campaignOperation: {
      create: {
        resourceName: campaign,
        name: `${plan.campaignName} (${plan.nameSuffix})`,
        advertisingChannelType: "DEMAND_GEN",
        campaignBudget: budget,
        // Maximize clicks. A local shop rarely has conversion tracking, and
        // the conversion-based strategies need it to mean anything.
        targetSpend: {},
        // Required on every new campaign since the EU political ads rules.
        containsEuPoliticalAdvertising: "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING",
        // PAUSED, always. Enabling is the advertiser's deliberate second step
        // in their own Google Ads account.
        status: "PAUSED",
      },
    },
  });

  ops.push({
    adGroupOperation: {
      create: {
        resourceName: adGroup,
        name: `${plan.campaignName} ads (${plan.nameSuffix})`,
        campaign,
        // ENABLED inside a PAUSED campaign: the campaign is the single
        // serving gate, so enabling it is all the advertiser has to do.
        status: "ENABLED",
        demandGenAdGroupSettings: {
          channelControls: {
            // YouTube only. AdVault sells YouTube and Shorts ads; Gmail,
            // Discover and Display would spend the budget somewhere the
            // advertiser did not choose.
            selectedChannels: {
              gmail: false,
              discover: false,
              display: false,
              youtubeInFeed: true,
              youtubeInStream: true,
              youtubeShorts: true,
            },
          },
        },
      },
    },
  });

  // Demand Gen takes location targeting on the ad group, not the campaign.
  for (const geoTargetConstant of plan.geoTargetConstants) {
    ops.push({
      adGroupCriterionOperation: {
        create: { adGroup, location: { geoTargetConstant } },
      },
    });
  }

  let tempAsset = -10;
  const videoAssets: string[] = [];
  for (const v of plan.videos) {
    if ("existing" in v) {
      videoAssets.push(v.existing);
      continue;
    }
    const resourceName = `${c}/assets/${tempAsset--}`;
    ops.push({
      assetOperation: {
        create: {
          resourceName,
          // Unique by construction, and traceable to a specific upload.
          name: `AdVault ${v.youtubeVideoId}`,
          youtubeVideoAsset: {
            youtubeVideoId: v.youtubeVideoId,
            youtubeVideoTitle: v.title.slice(0, 100),
          },
        },
      },
    });
    videoAssets.push(resourceName);
  }

  let logoAsset: string;
  if ("existing" in plan.logo) {
    logoAsset = plan.logo.existing;
  } else {
    logoAsset = `${c}/assets/${tempAsset--}`;
    ops.push({
      assetOperation: {
        create: {
          resourceName: logoAsset,
          name: plan.logo.name,
          type: "IMAGE",
          imageAsset: { data: plan.logo.base64 },
        },
      },
    });
  }

  const text = (list: string[]) => list.map((t) => ({ text: t }));

  ops.push({
    adGroupAdOperation: {
      create: {
        adGroup,
        status: "ENABLED",
        ad: {
          name: `${plan.campaignName} (${plan.nameSuffix})`,
          finalUrls: [plan.finalUrl],
          // Every published aspect ratio goes into the one ad; Google picks
          // the vertical cut for Shorts and the landscape one for in-stream.
          demandGenVideoResponsiveAd: {
            businessName: { text: plan.copy.businessName },
            headlines: text(plan.copy.headlines),
            longHeadlines: text(plan.copy.longHeadlines),
            descriptions: text(plan.copy.descriptions),
            videos: videoAssets.map((asset) => ({ asset })),
            logoImages: [{ asset: logoAsset }],
          },
        },
      },
    },
  });

  return ops;
}

export type LaunchResult = {
  budgetResourceName: string;
  campaignResourceName: string;
  adGroupResourceName: string;
  adResourceName: string;
};

type MutateResponse = {
  mutateOperationResponses?: {
    campaignBudgetResult?: { resourceName?: string };
    campaignResult?: { resourceName?: string };
    adGroupResult?: { resourceName?: string };
    adGroupAdResult?: { resourceName?: string };
  }[];
};

/** Pulls the four resource names this app stores out of a Mutate response. */
export function parseLaunchResponse(body: MutateResponse): LaunchResult {
  const r = body.mutateOperationResponses ?? [];
  const pick = (k: keyof (typeof r)[number]) =>
    r.map((x) => x[k]?.resourceName).find((n): n is string => Boolean(n));

  const result = {
    budgetResourceName: pick("campaignBudgetResult"),
    campaignResourceName: pick("campaignResult"),
    adGroupResourceName: pick("adGroupResult"),
    adResourceName: pick("adGroupAdResult"),
  };
  for (const [k, v] of Object.entries(result)) {
    if (!v) throw new Error(`Google Ads returned no ${k}`);
  }
  return result as LaunchResult;
}

/**
 * Sends the whole launch. With `validateOnly`, Google checks every operation
 * and creates nothing — used for a dry run against a real account.
 */
export async function launchDemandGen(
  ctx: GoogleCtx,
  plan: LaunchPlan,
  opts: { validateOnly?: boolean } = {},
): Promise<LaunchResult | null> {
  const body = await googleAdsCall<MutateResponse>(
    `/customers/${ctx.customerId}/googleAds:mutate`,
    ctx.accessToken,
    {
      method: "POST",
      loginCustomerId: ctx.loginCustomerId,
      body: {
        mutateOperations: buildLaunchOperations(plan),
        validateOnly: Boolean(opts.validateOnly),
      },
    },
  );
  return opts.validateOnly ? null : parseLaunchResponse(body);
}

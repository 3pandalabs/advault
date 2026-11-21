// "Change my offer" at Google (2026-11-21, lib/offerSwap): a NEW ad in the
// SAME ad group, then — only after Google approves it — the old ad paused
// (the base / launched ad, which the campaign returns to) or removed (a
// previous offer's ad). The campaign, its budget, targeting and stats are
// never touched, so the numbers stay on the one campaign.
//
// Objects (Google Ads REST, the version pinned in env.ts):
//   googleAds:search  FROM ad_group_ad WHERE ad_group_ad.resource_name = …
//                     (final_urls, logo_images, status, policy_summary)
//   googleAds:mutate  assetOperation.create (YOUTUBE_VIDEO, new videos only)
//                     + adGroupAdOperation.create (demandGenVideoResponsiveAd,
//                     status ENABLED) — one atomic request
//   googleAds:mutate  adGroupAdOperation.update {status PAUSED|ENABLED,
//                     updateMask "status"} / adGroupAdOperation.remove
//                     — the swap itself, one atomic request
//
// Shapes are from the REST reference and follow the launch mutate
// (lib/googleAds/demandGen.ts), which Google accepted. NOT yet proven with a
// validateOnly mutate against the test customer: do that before relying on
// it (see CLAUDE.md "Change my offer").

import { googleAdsCall } from "./client.js";
import type { AdCopy, GoogleCtx } from "./demandGen.js";
import { googlePolicyLabel, type GooglePolicyLabel } from "../adMetrics/adPolicy.js";

function gaqlString(value: string): string {
  return value.replace(/['\\]/g, "");
}

export function adDetailsQuery(adGroupAdResourceName: string): string {
  return (
    "SELECT ad_group_ad.resource_name, ad_group_ad.status, ad_group_ad.ad.final_urls, " +
    "ad_group_ad.ad.demand_gen_video_responsive_ad.logo_images, " +
    "ad_group_ad.policy_summary.approval_status, ad_group_ad.policy_summary.review_status, " +
    "ad_group_ad.policy_summary.policy_topic_entries " +
    `FROM ad_group_ad WHERE ad_group_ad.resource_name = '${gaqlString(adGroupAdResourceName)}'`
  );
}

type GaqlAdDetails = {
  adGroupAd?: {
    resourceName?: string;
    status?: string;
    ad?: {
      finalUrls?: string[];
      demandGenVideoResponsiveAd?: { logoImages?: { asset?: string }[] };
    };
    policySummary?: {
      approvalStatus?: string;
      reviewStatus?: string;
      policyTopicEntries?: { topic?: string }[];
    };
  };
};

export type AdDetails = {
  resourceName: string;
  status: string;
  finalUrl: string | null;
  logoAsset: string | null;
  policy: GooglePolicyLabel;
  topics: string[];
};

export function parseAdDetails(results: GaqlAdDetails[] | undefined): AdDetails | null {
  const r = results?.[0]?.adGroupAd;
  if (!r?.resourceName) return null;
  return {
    resourceName: r.resourceName,
    status: r.status ?? "UNKNOWN",
    finalUrl: r.ad?.finalUrls?.[0] ?? null,
    logoAsset: r.ad?.demandGenVideoResponsiveAd?.logoImages?.[0]?.asset ?? null,
    policy: googlePolicyLabel(r.policySummary?.approvalStatus ?? null, r.policySummary?.reviewStatus ?? null),
    topics: [...new Set((r.policySummary?.policyTopicEntries ?? []).map((e) => e.topic).filter((t): t is string => Boolean(t)))],
  };
}

export async function readAd(ctx: GoogleCtx, adGroupAdResourceName: string): Promise<AdDetails | null> {
  const body = await googleAdsCall<{ results?: GaqlAdDetails[] }>(`/customers/${ctx.customerId}/googleAds:search`, ctx.accessToken, {
    method: "POST",
    loginCustomerId: ctx.loginCustomerId,
    body: { query: adDetailsQuery(adGroupAdResourceName) },
  });
  return parseAdDetails(body.results);
}

/** The ad group an ad belongs to: customers/1/adGroupAds/22~33 -> customers/1/adGroups/22. */
export function adGroupOf(adGroupAdResourceName: string): string | null {
  const m = adGroupAdResourceName.match(/^(customers\/\d+)\/adGroupAds\/(\d+)~\d+$/);
  return m ? `${m[1]}/adGroups/${m[2]}` : null;
}

export type AddAdPlan = {
  customerId: string;
  adGroup: string;
  name: string;
  finalUrl: string;
  copy: AdCopy;
  /** One per published creative: an asset Google already has, or a video to create. */
  videos: ({ existing: string } | { youtubeVideoId: string; title: string })[];
  logoAsset: string;
  /** ENABLED for an offer (it serves only once approved); PAUSED for a parked base cut. */
  status: "ENABLED" | "PAUSED";
};

/** The add-an-ad mutate body. Pure, so the shape Google receives is tested. */
export function buildAddAdOperations(plan: AddAdPlan): unknown[] {
  if (plan.videos.length === 0) throw new Error("an ad needs at least one video");
  const c = `customers/${plan.customerId}`;
  const ops: unknown[] = [];
  let temp = -20;
  const videoAssets: string[] = [];
  for (const v of plan.videos) {
    if ("existing" in v) {
      videoAssets.push(v.existing);
      continue;
    }
    const resourceName = `${c}/assets/${temp--}`;
    ops.push({
      assetOperation: {
        create: {
          resourceName,
          name: `AdVault ${v.youtubeVideoId}`,
          youtubeVideoAsset: { youtubeVideoId: v.youtubeVideoId, youtubeVideoTitle: v.title.slice(0, 100) },
        },
      },
    });
    videoAssets.push(resourceName);
  }
  const text = (list: string[]) => list.map((t) => ({ text: t }));
  ops.push({
    adGroupAdOperation: {
      create: {
        adGroup: plan.adGroup,
        status: plan.status,
        ad: {
          name: plan.name.slice(0, 255),
          finalUrls: [plan.finalUrl],
          demandGenVideoResponsiveAd: {
            businessName: { text: plan.copy.businessName },
            headlines: text(plan.copy.headlines),
            longHeadlines: text(plan.copy.longHeadlines),
            descriptions: text(plan.copy.descriptions),
            videos: videoAssets.map((asset) => ({ asset })),
            logoImages: [{ asset: plan.logoAsset }],
          },
        },
      },
    },
  });
  return ops;
}

type MutateResponse = { mutateOperationResponses?: { adGroupAdResult?: { resourceName?: string } }[] };

export async function addAd(ctx: GoogleCtx, plan: AddAdPlan, opts: { validateOnly?: boolean } = {}): Promise<string | null> {
  const body = await googleAdsCall<MutateResponse>(`/customers/${ctx.customerId}/googleAds:mutate`, ctx.accessToken, {
    method: "POST",
    loginCustomerId: ctx.loginCustomerId,
    body: { mutateOperations: buildAddAdOperations(plan), validateOnly: Boolean(opts.validateOnly) },
  });
  if (opts.validateOnly) return null;
  const rn = (body.mutateOperationResponses ?? []).map((r) => r.adGroupAdResult?.resourceName).find(Boolean);
  if (!rn) throw new Error("Google Ads returned no adGroupAd");
  return rn;
}

export type StatusChanges = { enable?: string[]; pause?: string[]; remove?: string[] };

/** One atomic mutate that flips/removes ads. Pure. */
export function buildStatusOperations(ch: StatusChanges): unknown[] {
  const update = (resourceName: string, status: "ENABLED" | "PAUSED") => ({
    adGroupAdOperation: { update: { resourceName, status }, updateMask: "status" },
  });
  return [
    ...(ch.enable ?? []).map((r) => update(r, "ENABLED")),
    ...(ch.pause ?? []).map((r) => update(r, "PAUSED")),
    ...(ch.remove ?? []).map((r) => ({ adGroupAdOperation: { remove: r } })),
  ];
}

export async function changeAdStatuses(ctx: GoogleCtx, ch: StatusChanges): Promise<void> {
  const ops = buildStatusOperations(ch);
  if (ops.length === 0) return;
  await googleAdsCall(`/customers/${ctx.customerId}/googleAds:mutate`, ctx.accessToken, {
    method: "POST",
    loginCustomerId: ctx.loginCustomerId,
    body: { mutateOperations: ops },
  });
}

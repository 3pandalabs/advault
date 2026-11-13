// Pure half of "what did Google's own ad review say" (no db, no fetch).
//
// Google reviews every ad after launch, whatever AdVault's own review said.
// The renderer's hourly report sweep (render/adMetricsSync.ts) reads
// ad_group_ad.policy_summary with one extra read-only googleAds:search per
// account and stores the result on the campaign; the campaign page shows it
// as "Google: Approved / Under review / Disapproved".

export const AD_POLICY_QUERY =
  "SELECT campaign.resource_name, ad_group_ad.resource_name, " +
  "ad_group_ad.policy_summary.approval_status, ad_group_ad.policy_summary.review_status, " +
  "ad_group_ad.policy_summary.policy_topic_entries " +
  "FROM ad_group_ad WHERE ad_group_ad.status != 'REMOVED'";

/** One element of the search `results` array, as the REST API returns it. */
export type GaqlAdPolicyResult = {
  campaign?: { resourceName?: string };
  adGroupAd?: {
    resourceName?: string;
    policySummary?: {
      approvalStatus?: string;
      reviewStatus?: string;
      policyTopicEntries?: { topic?: string; type?: string }[];
    };
  };
};

export type AdPolicyRow = {
  campaignResourceName: string;
  approvalStatus: string;
  reviewStatus: string;
  topics: string[];
};

export type GooglePolicyLabel = "approved" | "approved_limited" | "under_review" | "disapproved" | "unknown";

/** What the advertiser is told, from Google's raw enums. */
export function googlePolicyLabel(approvalStatus: string | null, reviewStatus: string | null): GooglePolicyLabel {
  if (approvalStatus === "DISAPPROVED") return "disapproved";
  if (reviewStatus === "REVIEW_IN_PROGRESS" || reviewStatus === "UNDER_APPEAL") return "under_review";
  if (approvalStatus === "APPROVED") return "approved";
  if (approvalStatus === "APPROVED_LIMITED" || approvalStatus === "AREA_OF_INTEREST_ONLY") return "approved_limited";
  // ELIGIBLE_MAY_SERVE with UNKNOWN approval: Google has not finished looking.
  if (reviewStatus === "ELIGIBLE_MAY_SERVE" || reviewStatus === "REVIEWED") return "under_review";
  return "unknown";
}

const SEVERITY: Record<GooglePolicyLabel, number> = {
  disapproved: 4,
  under_review: 3,
  approved_limited: 2,
  approved: 1,
  unknown: 0,
};

/**
 * One row per campaign. AdVault puts exactly one ad in each campaign, but if
 * a campaign ever holds more, the worst verdict is the one worth showing.
 */
export function parseAdPolicyResults(results: GaqlAdPolicyResult[] | undefined): AdPolicyRow[] {
  const byCampaign = new Map<string, AdPolicyRow>();
  for (const r of results ?? []) {
    const campaignResourceName = r.campaign?.resourceName;
    const summary = r.adGroupAd?.policySummary;
    if (!campaignResourceName || !summary) continue;
    const row: AdPolicyRow = {
      campaignResourceName,
      approvalStatus: summary.approvalStatus ?? "UNKNOWN",
      reviewStatus: summary.reviewStatus ?? "UNKNOWN",
      topics: [...new Set((summary.policyTopicEntries ?? []).map((e) => e.topic).filter((t): t is string => Boolean(t)))],
    };
    const prev = byCampaign.get(campaignResourceName);
    const sev = (x: AdPolicyRow) => SEVERITY[googlePolicyLabel(x.approvalStatus, x.reviewStatus)];
    if (!prev || sev(row) > sev(prev)) byCampaign.set(campaignResourceName, row);
  }
  return [...byCampaign.values()];
}

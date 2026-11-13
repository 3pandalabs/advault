import { describe, expect, it } from "vitest";
import { AD_POLICY_QUERY, googlePolicyLabel, parseAdPolicyResults } from "./adPolicy.js";

describe("AD_POLICY_QUERY", () => {
  it("reads the policy summary from ad_group_ad and never mutates", () => {
    expect(AD_POLICY_QUERY).toContain("ad_group_ad.policy_summary.approval_status");
    expect(AD_POLICY_QUERY).toContain("ad_group_ad.policy_summary.review_status");
    expect(AD_POLICY_QUERY).toMatch(/^SELECT /);
  });
});

describe("googlePolicyLabel", () => {
  it("maps Google's enums to what the advertiser sees", () => {
    expect(googlePolicyLabel("APPROVED", "REVIEWED")).toBe("approved");
    expect(googlePolicyLabel("APPROVED_LIMITED", "REVIEWED")).toBe("approved_limited");
    expect(googlePolicyLabel("AREA_OF_INTEREST_ONLY", "REVIEWED")).toBe("approved_limited");
    expect(googlePolicyLabel("DISAPPROVED", "REVIEWED")).toBe("disapproved");
    expect(googlePolicyLabel("UNKNOWN", "REVIEW_IN_PROGRESS")).toBe("under_review");
    expect(googlePolicyLabel("UNKNOWN", "ELIGIBLE_MAY_SERVE")).toBe("under_review");
    expect(googlePolicyLabel("DISAPPROVED", "UNDER_APPEAL")).toBe("disapproved");
    expect(googlePolicyLabel(null, null)).toBe("unknown");
  });
});

describe("parseAdPolicyResults", () => {
  it("keeps one row per campaign, the worst verdict winning", () => {
    const rows = parseAdPolicyResults([
      {
        campaign: { resourceName: "customers/1/campaigns/9" },
        adGroupAd: { policySummary: { approvalStatus: "APPROVED", reviewStatus: "REVIEWED" } },
      },
      {
        campaign: { resourceName: "customers/1/campaigns/9" },
        adGroupAd: {
          policySummary: {
            approvalStatus: "DISAPPROVED",
            reviewStatus: "REVIEWED",
            policyTopicEntries: [{ topic: "COPYRIGHTED_CONTENT", type: "PROHIBITED" }, { topic: "COPYRIGHTED_CONTENT" }],
          },
        },
      },
      { campaign: { resourceName: "customers/1/campaigns/10" } },
      { adGroupAd: { policySummary: { approvalStatus: "APPROVED" } } },
    ]);
    expect(rows).toEqual([
      {
        campaignResourceName: "customers/1/campaigns/9",
        approvalStatus: "DISAPPROVED",
        reviewStatus: "REVIEWED",
        topics: ["COPYRIGHTED_CONTENT"],
      },
    ]);
  });

  it("tolerates an empty response", () => {
    expect(parseAdPolicyResults(undefined)).toEqual([]);
  });
});

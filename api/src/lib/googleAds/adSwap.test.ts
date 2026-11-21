import { describe, expect, it } from "vitest";
import { adDetailsQuery, adGroupOf, buildAddAdOperations, buildStatusOperations, parseAdDetails } from "./adSwap.js";

const copy = { businessName: "Sparkle", headlines: ["H"], longHeadlines: ["LH"], descriptions: ["D"] };

describe("add a NEW ad to the SAME ad group", () => {
  it("creates only the missing video assets and one adGroupAd", () => {
    const ops = buildAddAdOperations({
      customerId: "123",
      adGroup: "customers/123/adGroups/9",
      name: "Fall (offer abc)",
      finalUrl: "https://x.test/?utm_source=youtube",
      copy,
      videos: [{ existing: "customers/123/assets/1" }, { youtubeVideoId: "abcdefghijk", title: "Sparkle — Fall" }],
      logoAsset: "customers/123/assets/7",
      status: "ENABLED",
    }) as Record<string, any>[];
    expect(ops).toHaveLength(2);
    expect(ops[0].assetOperation.create.youtubeVideoAsset.youtubeVideoId).toBe("abcdefghijk");
    const ad = ops[1].adGroupAdOperation.create;
    expect(ad.adGroup).toBe("customers/123/adGroups/9");
    expect(ad.status).toBe("ENABLED");
    expect(ad.ad.finalUrls).toEqual(["https://x.test/?utm_source=youtube"]);
    expect(ad.ad.demandGenVideoResponsiveAd.videos).toEqual([{ asset: "customers/123/assets/1" }, { asset: "customers/123/assets/-20" }]);
    expect(ad.ad.demandGenVideoResponsiveAd.logoImages).toEqual([{ asset: "customers/123/assets/7" }]);
  });
  it("refuses an ad with no video", () => {
    expect(() =>
      buildAddAdOperations({ customerId: "1", adGroup: "g", name: "n", finalUrl: "u", copy, videos: [], logoAsset: "l", status: "PAUSED" }),
    ).toThrow();
  });
});

describe("the swap mutate", () => {
  it("enables, pauses and removes in one request", () => {
    expect(buildStatusOperations({ enable: ["a"], pause: ["b"], remove: ["c"] })).toEqual([
      { adGroupAdOperation: { update: { resourceName: "a", status: "ENABLED" }, updateMask: "status" } },
      { adGroupAdOperation: { update: { resourceName: "b", status: "PAUSED" }, updateMask: "status" } },
      { adGroupAdOperation: { remove: "c" } },
    ]);
    expect(buildStatusOperations({})).toEqual([]);
  });
  it("reads the ad group from an ad resource name", () => {
    expect(adGroupOf("customers/123/adGroupAds/45~678")).toBe("customers/123/adGroups/45");
    expect(adGroupOf("nope")).toBeNull();
  });
  it("parses the ad details search", () => {
    expect(adDetailsQuery("customers/1/adGroupAds/2~3'")).toContain("ad_group_ad.resource_name = 'customers/1/adGroupAds/2~3'");
    const d = parseAdDetails([
      {
        adGroupAd: {
          resourceName: "customers/1/adGroupAds/2~3",
          status: "ENABLED",
          ad: { finalUrls: ["https://x.test"], demandGenVideoResponsiveAd: { logoImages: [{ asset: "customers/1/assets/9" }] } },
          policySummary: { approvalStatus: "DISAPPROVED", reviewStatus: "REVIEWED", policyTopicEntries: [{ topic: "MISLEADING" }] },
        },
      },
    ]);
    expect(d).toEqual({ resourceName: "customers/1/adGroupAds/2~3", status: "ENABLED", finalUrl: "https://x.test", logoAsset: "customers/1/assets/9", policy: "disapproved", topics: ["MISLEADING"] });
    expect(parseAdDetails([])).toBeNull();
  });
});

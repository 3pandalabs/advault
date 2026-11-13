import { describe, expect, it } from "vitest";
import {
  TEXT_LIMITS,
  buildAdCopy,
  buildLaunchOperations,
  fitText,
  parseLaunchResponse,
  type LaunchPlan,
} from "./demandGen.js";

const basePlan: LaunchPlan = {
  customerId: "1234567890",
  nameSuffix: "31415eeb",
  campaignName: "Spring offer",
  dailyBudgetCents: 1500,
  finalUrl: "https://example.com",
  geoTargetConstants: ["geoTargetConstants/9001", "geoTargetConstants/9002"],
  copy: {
    businessName: "Sharma Salon",
    headlines: ["Haircut ₹499 till Sunday"],
    longHeadlines: ["Haircut ₹499 till Sunday at Sharma Salon"],
    descriptions: ["Walk in or call to book."],
  },
  videos: [
    { existing: "customers/1234567890/assets/555" },
    { youtubeVideoId: "QzBSTfs8_RM", title: "Sharma Salon — Spring offer" },
  ],
  logo: { name: "AdVault logo abc", base64: "iVBORw0KGgo=" },
};

type Op = Record<string, { create: Record<string, unknown> }>;
const ops = (plan = basePlan) => buildLaunchOperations(plan) as Op[];
const ofType = (list: Op[], k: string) => list.filter((o) => k in o).map((o) => o[k]!.create);

describe("buildLaunchOperations", () => {
  // The bug this module replaced: VIDEO campaigns cannot be created through
  // the API at all, so every launch failed with MUTATE_NOT_ALLOWED.
  it("creates a DEMAND_GEN campaign, never a VIDEO one", () => {
    const [campaign] = ofType(ops(), "campaignOperation");
    expect(campaign!.advertisingChannelType).toBe("DEMAND_GEN");
    expect(campaign).not.toHaveProperty("advertisingChannelSubType");
    expect(JSON.stringify(ops())).not.toContain('"VIDEO"');
  });

  it("creates the campaign PAUSED with the required EU political field", () => {
    const [campaign] = ofType(ops(), "campaignOperation");
    expect(campaign!.status).toBe("PAUSED");
    expect(campaign!.containsEuPoliticalAdvertising).toBe(
      "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING",
    );
  });

  // Off by a thousand here is a 1000x overspend on someone's card.
  it("sends the budget in micros, unshared", () => {
    const [budget] = ofType(ops(), "campaignBudgetOperation");
    expect(budget!.amountMicros).toBe("15000000");
    expect(budget!.explicitlyShared).toBe(false);
  });

  it("orders operations so every temp id exists before it is referenced", () => {
    const keys = ops().map((o) => Object.keys(o)[0]);
    expect(keys[0]).toBe("campaignBudgetOperation");
    expect(keys[1]).toBe("campaignOperation");
    expect(keys[2]).toBe("adGroupOperation");
    expect(keys.at(-1)).toBe("adGroupAdOperation");
  });

  it("targets locations on the ad group, one criterion per geo constant", () => {
    const criteria = ofType(ops(), "adGroupCriterionOperation");
    expect(criteria).toHaveLength(2);
    expect(criteria[0]).toEqual({
      adGroup: "customers/1234567890/adGroups/-3",
      location: { geoTargetConstant: "geoTargetConstants/9001" },
    });
  });

  it("restricts the ad group to YouTube placements", () => {
    const [adGroup] = ofType(ops(), "adGroupOperation");
    expect(adGroup!.demandGenAdGroupSettings).toEqual({
      channelControls: {
        selectedChannels: {
          gmail: false,
          discover: false,
          display: false,
          youtubeInFeed: true,
          youtubeInStream: true,
          youtubeShorts: true,
        },
      },
    });
  });

  it("reuses existing assets and creates only the missing ones", () => {
    const assets = ofType(ops(), "assetOperation");
    expect(assets).toHaveLength(2); // one new video + the new logo
    const ad = ofType(ops(), "adGroupAdOperation")[0]!.ad as {
      demandGenVideoResponsiveAd: { videos: { asset: string }[]; logoImages: { asset: string }[] };
    };
    expect(ad.demandGenVideoResponsiveAd.videos.map((v) => v.asset)).toEqual([
      "customers/1234567890/assets/555",
      assets[0]!.resourceName,
    ]);
    expect(ad.demandGenVideoResponsiveAd.logoImages[0]!.asset).toBe(assets[1]!.resourceName);
  });

  it("creates no logo asset when one already exists in the account", () => {
    const list = ops({ ...basePlan, logo: { existing: "customers/1234567890/assets/777" } });
    expect(ofType(list, "assetOperation")).toHaveLength(1);
  });

  // Platform-billed customers cannot reach Google Ads to switch it on.
  it("creates the campaign ENABLED only when asked to", () => {
    const [campaign] = ofType(ops({ ...basePlan, campaignStatus: "ENABLED" }), "campaignOperation");
    expect(campaign!.status).toBe("ENABLED");
  });

  it("targets only people present in the locations, not those interested in them", () => {
    const [campaign] = ofType(ops(), "campaignOperation");
    expect(campaign!.geoTargetTypeSetting).toEqual({ positiveGeoTargetType: "PRESENCE" });
  });

  it("refuses to build a launch with no locations", () => {
    expect(() => ops({ ...basePlan, geoTargetConstants: [] })).toThrow(/no location/);
  });

  it("refuses to build a launch with no video", () => {
    expect(() => ops({ ...basePlan, videos: [] })).toThrow(/no video/);
  });
});

describe("buildLaunchOperations — audience filters", () => {
  const dims = [{ age: { ageRanges: [{ minAge: 25, maxAge: 44 }], includeUndetermined: false } }];

  it("adds nothing when there are no filters (everyone)", () => {
    const list = ops();
    expect(ofType(list, "audienceOperation")).toHaveLength(0);
    const [adGroup] = ofType(list, "adGroupOperation");
    expect(adGroup).not.toHaveProperty("audienceSetting");
  });

  it("attaches demographics as one grouped Audience on the ad group", () => {
    const list = ops({ ...basePlan, audienceDimensions: dims });
    const [adGroup] = ofType(list, "adGroupOperation");
    expect(adGroup!.audienceSetting).toEqual({ useAudienceGrouped: true });
    const [audience] = ofType(list, "audienceOperation");
    expect(audience).toMatchObject({
      resourceName: "customers/1234567890/audiences/-4",
      name: "AdVault audience 31415eeb",
      dimensions: dims,
    });
    const criteria = ofType(list, "adGroupCriterionOperation");
    expect(criteria).toContainEqual({
      adGroup: "customers/1234567890/adGroups/-3",
      audience: { audience: "customers/1234567890/audiences/-4" },
    });
    // The Audience must exist before the criterion that references it.
    const keys = list.map((o) => Object.keys(o)[0]);
    const audienceIdx = keys.indexOf("audienceOperation");
    const refIdx = list.findIndex((o) => JSON.stringify(o).includes('"audience":{"audience"'));
    expect(audienceIdx).toBeLessThan(refIdx);
  });

  it("targets languages on the ad group for ZIP campaigns", () => {
    const list = ops({ ...basePlan, languageConstants: ["languageConstants/1003"] });
    expect(ofType(list, "adGroupCriterionOperation")).toContainEqual({
      adGroup: "customers/1234567890/adGroups/-3",
      language: { languageConstant: "languageConstants/1003" },
    });
    expect(ofType(list, "campaignCriterionOperation")).toHaveLength(0);
  });
});

describe("buildLaunchOperations — housing (real estate)", () => {
  const housingPlan: LaunchPlan = {
    ...basePlan,
    geoTargetConstants: [],
    housing: true,
    proximity: {
      address: { street: "12 Elm St", city: "Austin", state: "TX", postalCode: "78701" },
      radiusMiles: 15,
    },
    languageConstants: ["languageConstants/1000"],
  };

  it("targets a radius on the campaign, with upgraded targeting off", () => {
    const list = ops(housingPlan);
    const [campaign] = ofType(list, "campaignOperation");
    expect(campaign!.demandGenCampaignSettings).toEqual({ upgradedTargeting: false });
    const criteria = ofType(list, "campaignCriterionOperation");
    expect(criteria[0]).toEqual({
      campaign: "customers/1234567890/campaigns/-2",
      proximity: {
        address: {
          streetAddress: "12 Elm St",
          cityName: "Austin",
          provinceCode: "TX",
          postalCode: "78701",
          countryCode: "US",
        },
        radius: 15,
        radiusUnits: "MILES",
      },
    });
    // Language moves to the campaign with location.
    expect(criteria[1]).toEqual({
      campaign: "customers/1234567890/campaigns/-2",
      language: { languageConstant: "languageConstants/1000" },
    });
    // No ZIP / geo-constant criteria at all.
    expect(JSON.stringify(list)).not.toContain("geoTargetConstant");
  });

  it.each(["age", "gender", "parentalStatus"])("refuses a %s dimension", (k) => {
    expect(() => ops({ ...housingPlan, audienceDimensions: [{ [k]: {} }] })).toThrow(/housing/);
  });

  it("allows a household income dimension", () => {
    const list = ops({ ...housingPlan, audienceDimensions: [{ householdIncome: { incomeRanges: [] } }] });
    expect(ofType(list, "audienceOperation")).toHaveLength(1);
  });

  it("refuses ZIP geo constants or a missing radius", () => {
    expect(() => ops({ ...housingPlan, geoTargetConstants: ["geoTargetConstants/9001"] })).toThrow();
    expect(() => ops({ ...housingPlan, proximity: undefined, geoTargetConstants: ["geoTargetConstants/9001"] })).toThrow(
      /housing/,
    );
  });
});

describe("fitText", () => {
  it("leaves short text alone and collapses whitespace", () => {
    expect(fitText("  Call   now ", 40)).toBe("Call now");
  });

  it("cuts at a word boundary and drops trailing punctuation", () => {
    const out = fitText("Fresh haircuts, beard trims, and colour — all week long", 30);
    expect(out.length).toBeLessThanOrEqual(30);
    expect(out).toBe("Fresh haircuts, beard trims");
  });

  it("hard-cuts a single word longer than the limit", () => {
    expect(fitText("Supercalifragilisticexpialidocious", 10)).toBe("Supercalif");
  });

  it("returns empty for nothing", () => {
    expect(fitText(null, 10)).toBe("");
  });
});

describe("buildAdCopy", () => {
  const input = {
    businessName: "Sharma Family Hair & Beauty Salon",
    businessCategory: "salon",
    callToAction: "Call now",
    offerDetails: null,
    script: { hook: "Haircut ₹499 till Sunday", body: "Walk in today. No appointment needed." },
  };

  it("keeps every field within Google's limits", () => {
    const copy = buildAdCopy(input);
    expect(copy.businessName.length).toBeLessThanOrEqual(TEXT_LIMITS.businessName);
    for (const h of copy.headlines) expect(h.length).toBeLessThanOrEqual(TEXT_LIMITS.headline);
    for (const h of copy.longHeadlines) expect(h.length).toBeLessThanOrEqual(TEXT_LIMITS.longHeadline);
    for (const d of copy.descriptions) expect(d.length).toBeLessThanOrEqual(TEXT_LIMITS.description);
  });

  // Google requires at least one of each; a campaign without a script must
  // still produce a valid ad.
  it("always has at least one of each, even with no script", () => {
    const copy = buildAdCopy({ ...input, script: null });
    expect(copy.headlines.length).toBeGreaterThan(0);
    expect(copy.longHeadlines.length).toBeGreaterThan(0);
    expect(copy.descriptions.length).toBeGreaterThan(0);
  });

  it("leads with the script hook and drops duplicates", () => {
    const copy = buildAdCopy({ ...input, callToAction: "haircut ₹499 till sunday" });
    expect(copy.headlines[0]).toBe("Haircut ₹499 till Sunday");
    expect(copy.headlines.filter((h) => h.toLowerCase() === "haircut ₹499 till sunday")).toHaveLength(1);
  });
});

describe("parseLaunchResponse", () => {
  it("picks the four resource names out of the mixed response", () => {
    const result = parseLaunchResponse({
      mutateOperationResponses: [
        { campaignBudgetResult: { resourceName: "b" } },
        { campaignResult: { resourceName: "c" } },
        { adGroupResult: { resourceName: "g" } },
        {},
        { adGroupAdResult: { resourceName: "a" } },
      ],
    });
    expect(result).toEqual({
      budgetResourceName: "b",
      campaignResourceName: "c",
      adGroupResourceName: "g",
      adResourceName: "a",
    });
  });

  it("throws when Google returns no ad", () => {
    expect(() =>
      parseLaunchResponse({ mutateOperationResponses: [{ campaignResult: { resourceName: "c" } }] }),
    ).toThrow();
  });
});

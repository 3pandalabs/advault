import { describe, expect, it } from "vitest";
import { audienceDimensions, languageConstants } from "../audience/google.js";
import { adScheduleCriteria } from "../schedule/policy.js";
import {
  buildAudienceEditOperations,
  buildScheduleEditOperations,
  parseTargetingState,
  type AudienceEdit,
  type TargetingState,
} from "./targeting.js";

const C = "customers/1234567890";
const edit = (over: Partial<AudienceEdit> = {}): AudienceEdit => ({
  customerId: "1234567890",
  campaignResourceName: `${C}/campaigns/5`,
  adGroupResourceName: `${C}/adGroups/6`,
  audienceDimensions: [],
  languageConstants: [],
  housing: false,
  audienceName: "AdVault audience abcd1234 x",
  ...over,
});
const empty: TargetingState = { upgradedTargeting: true, audienceCriterion: null, languageCriteria: [], scheduleCriteria: [] };
const withAudience: TargetingState = {
  ...empty,
  audienceCriterion: { resourceName: `${C}/adGroupCriteria/6~77`, audience: `${C}/audiences/88` },
};
const ages3544 = audienceDimensions({ ages: ["35-44"] });

describe("parseTargetingState", () => {
  it("reads the audience and language criteria at both levels", () => {
    const s = parseTargetingState(
      [{ campaign: { demandGenCampaignSettings: { upgradedTargeting: false } } }],
      [
        { adGroupCriterion: { resourceName: "agc1", type: "AUDIENCE", audience: { audience: "aud1" } } },
        { adGroupCriterion: { resourceName: "agc2", type: "LANGUAGE", language: { languageConstant: "languageConstants/1000" } } },
      ],
      [{ campaignCriterion: { resourceName: "cc1", type: "LANGUAGE", language: { languageConstant: "languageConstants/1003" } } }],
    );
    expect(s).toEqual({
      upgradedTargeting: false,
      audienceCriterion: { resourceName: "agc1", audience: "aud1" },
      languageCriteria: [
        { resourceName: "agc2", languageConstant: "languageConstants/1000", level: "adGroup" },
        { resourceName: "cc1", languageConstant: "languageConstants/1003", level: "campaign" },
      ],
      scheduleCriteria: [],
    });
  });

  it("treats an absent setting as upgraded targeting (Google's Demand Gen default)", () => {
    expect(parseTargetingState([{ campaign: {} }], [], []).upgradedTargeting).toBe(true);
    expect(parseTargetingState([], [], []).audienceCriterion).toBeNull();
  });
});

describe("buildAudienceEditOperations", () => {
  it("updates the existing Audience's dimensions in place", () => {
    expect(buildAudienceEditOperations(withAudience, edit({ audienceDimensions: ages3544 }))).toEqual([
      { audienceOperation: { update: { resourceName: `${C}/audiences/88`, dimensions: ages3544 }, updateMask: "dimensions" } },
    ]);
  });

  it("creates and attaches an Audience when the campaign launched for everyone", () => {
    const ops = buildAudienceEditOperations(empty, edit({ audienceDimensions: ages3544 }));
    expect(ops).toEqual([
      {
        audienceOperation: {
          create: { resourceName: `${C}/audiences/-4`, name: "AdVault audience abcd1234 x", dimensions: ages3544 },
        },
      },
      { adGroupCriterionOperation: { create: { adGroup: `${C}/adGroups/6`, audience: { audience: `${C}/audiences/-4` } } } },
    ]);
  });

  it("removes the Audience criterion when widened back to everyone", () => {
    expect(buildAudienceEditOperations(withAudience, edit())).toEqual([
      { adGroupCriterionOperation: { remove: `${C}/adGroupCriteria/6~77` } },
    ]);
  });

  it("is empty when nothing changes", () => {
    expect(buildAudienceEditOperations(empty, edit())).toEqual([]);
    const s: TargetingState = {
      ...empty,
      languageCriteria: [{ resourceName: "agc9", languageConstant: "languageConstants/1003", level: "adGroup" }],
    };
    expect(buildAudienceEditOperations(s, edit({ languageConstants: languageConstants({ languages: ["es"] }) }))).toEqual([]);
  });

  it("diffs languages on the ad group (upgraded targeting)", () => {
    const s: TargetingState = {
      ...empty,
      languageCriteria: [
        { resourceName: "agc-en", languageConstant: "languageConstants/1000", level: "adGroup" },
        { resourceName: "agc-es", languageConstant: "languageConstants/1003", level: "adGroup" },
      ],
    };
    const ops = buildAudienceEditOperations(s, edit({ languageConstants: ["languageConstants/1003", "languageConstants/1012"] }));
    expect(ops).toEqual([
      { adGroupCriterionOperation: { remove: "agc-en" } },
      { adGroupCriterionOperation: { create: { adGroup: `${C}/adGroups/6`, language: { languageConstant: "languageConstants/1012" } } } },
    ]);
  });

  it("puts new languages on the campaign for a proximity (non-upgraded) launch", () => {
    const s: TargetingState = {
      upgradedTargeting: false,
      audienceCriterion: null,
      languageCriteria: [{ resourceName: "cc-en", languageConstant: "languageConstants/1000", level: "campaign" }],
      scheduleCriteria: [],
    };
    expect(buildAudienceEditOperations(s, edit({ languageConstants: ["languageConstants/1003"] }))).toEqual([
      { campaignCriterionOperation: { remove: "cc-en" } },
      { campaignCriterionOperation: { create: { campaign: `${C}/campaigns/5`, language: { languageConstant: "languageConstants/1003" } } } },
    ]);
  });

  it("refuses age / gender / parental dimensions for a housing ad, allows income", () => {
    for (const f of [{ ages: ["35-44"] }, { genders: ["female"] }, { parentalStatuses: ["parent"] }] as const) {
      expect(() =>
        buildAudienceEditOperations(withAudience, edit({ housing: true, audienceDimensions: audienceDimensions(f as never) })),
      ).toThrow(/housing/);
    }
    const income = audienceDimensions({ incomes: ["top_10"] });
    expect(buildAudienceEditOperations(withAudience, edit({ housing: true, audienceDimensions: income }))).toHaveLength(1);
  });
});

describe("buildScheduleEditOperations", () => {
  const camp = `${C}/campaigns/5`;
  const monFri9to5 = adScheduleCriteria({ days: ["mon", "tue", "wed", "thu", "fri"], startHour: 9, endHour: 17 });

  it("creates one AdSchedule per day on a campaign that had none", () => {
    const ops = buildScheduleEditOperations({ scheduleCriteria: [] }, camp, monFri9to5) as {
      campaignCriterionOperation: { create: { campaign: string; adSchedule: { dayOfWeek: string } } };
    }[];
    expect(ops).toHaveLength(5);
    expect(ops[0]).toEqual({
      campaignCriterionOperation: {
        create: {
          campaign: camp,
          adSchedule: { dayOfWeek: "MONDAY", startHour: 9, startMinute: "ZERO", endHour: 17, endMinute: "ZERO" },
        },
      },
    });
  });

  it("keeps identical days, removes dropped ones, adds new ones", () => {
    const state = {
      scheduleCriteria: [
        { resourceName: "cc-mon", dayOfWeek: "MONDAY", startHour: 9, startMinute: "ZERO" as const, endHour: 17, endMinute: "ZERO" as const },
        { resourceName: "cc-sun", dayOfWeek: "SUNDAY", startHour: 9, startMinute: "ZERO" as const, endHour: 17, endMinute: "ZERO" as const },
      ],
    };
    const wanted = adScheduleCriteria({ days: ["mon", "sat"], startHour: 9, endHour: 17 });
    expect(buildScheduleEditOperations(state, camp, wanted)).toEqual([
      { campaignCriterionOperation: { remove: "cc-sun" } },
      { campaignCriterionOperation: { create: { campaign: camp, adSchedule: wanted[1] } } },
    ]);
  });

  it("removes every window to go back to all day, every day", () => {
    const state = { scheduleCriteria: [{ resourceName: "cc-mon", dayOfWeek: "MONDAY", startHour: 9, endHour: 17 }] };
    expect(buildScheduleEditOperations(state, camp, [])).toEqual([{ campaignCriterionOperation: { remove: "cc-mon" } }]);
  });

  it("a changed window on the same day is a remove + create", () => {
    const state = { scheduleCriteria: [{ resourceName: "cc-mon", dayOfWeek: "MONDAY", startHour: 9, startMinute: "ZERO" as const, endHour: 17, endMinute: "ZERO" as const }] };
    const wanted = adScheduleCriteria({ days: ["mon"], startHour: 10, endHour: 18 });
    expect(buildScheduleEditOperations(state, camp, wanted)).toHaveLength(2);
  });
});

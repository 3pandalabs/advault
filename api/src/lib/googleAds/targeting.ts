import { googleAdsCall } from "./client.js";
import type { GoogleCtx } from "./demandGen.js";
import { scheduleKey, type AdScheduleInfo } from "../schedule/policy.js";

// ---------------------------------------------------------------------------
// Changing a LAUNCHED campaign's targeting at Google (2026-11-20).
//
// Until now "Who should see it" reached Google once, at launch
// (demandGen.ts), and PATCH /campaigns refused a live campaign, so the only
// way to narrow or widen a running ad was a new campaign. This module reads
// what the campaign currently has at Google and builds ONE atomic mutate that
// turns it into what the advertiser picked:
//
//   * Demographics: the ad group's single AudienceInfo criterion points at an
//     Audience whose dimensions carry age / gender / parental / income
//     (lib/audience/google.ts). Has one + still wanted: UPDATE the Audience's
//     dimensions in place. None + now wanted: create an Audience and attach
//     it. Has one + no longer wanted: REMOVE the criterion (everyone again;
//     the Audience is left unattached, Google has no Audience remove).
//   * Languages: LanguageInfo criteria, on the ad group (upgraded targeting,
//     the default) or on the campaign (real estate / proximity launches,
//     upgraded_targeting = false). Removed and created to match.
//   * Days and hours (0037): AdSchedule campaign criteria, one per day.
//     Unchanged ones stay; the rest are removed and the new ones created.
//
// Read from Google, not from our row, because campaigns launched before
// migration 0036 never stored the Audience, and Google is the truth for what
// is serving. Validated 2026-11-20 with validateOnly mutates against the test
// customer: an Audience criterion on a Demand Gen ad group created WITHOUT
// audience_setting.use_audience_grouped is accepted, so campaigns launched
// with no filters can be narrowed later. Update/remove operation shapes were
// accepted (RESOURCE_NOT_FOUND on fake ids, never a shape error).
// ---------------------------------------------------------------------------

export type TargetingState = {
  /** false for a proximity (housing) launch: language lives on the campaign. */
  upgradedTargeting: boolean;
  /** The ad group's Audience criterion, if any. */
  audienceCriterion: { resourceName: string; audience: string } | null;
  /** Language criteria wherever they live. */
  languageCriteria: { resourceName: string; languageConstant: string; level: "adGroup" | "campaign" }[];
  /** AdSchedule campaign criteria. */
  scheduleCriteria: ({ resourceName: string } & Partial<AdScheduleInfo>)[];
};

type SearchRow = {
  campaign?: { demandGenCampaignSettings?: { upgradedTargeting?: boolean } };
  adGroupCriterion?: {
    resourceName?: string;
    type?: string;
    audience?: { audience?: string };
    language?: { languageConstant?: string };
  };
  campaignCriterion?: {
    resourceName?: string;
    type?: string;
    language?: { languageConstant?: string };
    adSchedule?: Partial<AdScheduleInfo>;
  };
};

// Resource names come from our own row (Google's format, digits and ~ only);
// stripped of quotes so a malformed value can't break the query.
function q(value: string): string {
  return value.replace(/['\\]/g, "");
}

async function search(ctx: GoogleCtx, query: string): Promise<SearchRow[]> {
  const body = await googleAdsCall<{ results?: SearchRow[] }>(
    `/customers/${ctx.customerId}/googleAds:search`,
    ctx.accessToken,
    { method: "POST", loginCustomerId: ctx.loginCustomerId, body: { query } },
  );
  return body.results ?? [];
}

/** What targeting the campaign has at Google right now. Three read-only searches. */
export async function fetchTargetingState(
  ctx: GoogleCtx,
  refs: { campaignResourceName: string; adGroupResourceName: string },
): Promise<TargetingState> {
  const [campaignRows, adGroupRows, campaignCriteriaRows] = await Promise.all([
    search(
      ctx,
      `SELECT campaign.demand_gen_campaign_settings.upgraded_targeting FROM campaign WHERE campaign.resource_name = '${q(refs.campaignResourceName)}'`,
    ),
    search(
      ctx,
      `SELECT ad_group_criterion.resource_name, ad_group_criterion.type, ad_group_criterion.audience.audience, ad_group_criterion.language.language_constant FROM ad_group_criterion WHERE ad_group.resource_name = '${q(refs.adGroupResourceName)}' AND ad_group_criterion.type IN ('AUDIENCE', 'LANGUAGE') AND ad_group_criterion.status != 'REMOVED'`,
    ),
    search(
      ctx,
      `SELECT campaign_criterion.resource_name, campaign_criterion.type, campaign_criterion.language.language_constant, campaign_criterion.ad_schedule.day_of_week, campaign_criterion.ad_schedule.start_hour, campaign_criterion.ad_schedule.start_minute, campaign_criterion.ad_schedule.end_hour, campaign_criterion.ad_schedule.end_minute FROM campaign_criterion WHERE campaign.resource_name = '${q(refs.campaignResourceName)}' AND campaign_criterion.type IN ('LANGUAGE', 'AD_SCHEDULE') AND campaign_criterion.status != 'REMOVED'`,
    ),
  ]);
  return parseTargetingState(campaignRows, adGroupRows, campaignCriteriaRows);
}

/** Pure: search rows -> TargetingState. */
export function parseTargetingState(
  campaignRows: SearchRow[],
  adGroupRows: SearchRow[],
  campaignCriteriaRows: SearchRow[],
): TargetingState {
  // Absent = Google's default for Demand Gen, which is upgraded (true).
  const upgraded = campaignRows[0]?.campaign?.demandGenCampaignSettings?.upgradedTargeting;
  let audienceCriterion: TargetingState["audienceCriterion"] = null;
  const languageCriteria: TargetingState["languageCriteria"] = [];
  for (const r of adGroupRows) {
    const c = r.adGroupCriterion;
    if (!c?.resourceName) continue;
    if (c.type === "AUDIENCE" && c.audience?.audience && !audienceCriterion) {
      audienceCriterion = { resourceName: c.resourceName, audience: c.audience.audience };
    } else if (c.type === "LANGUAGE" && c.language?.languageConstant) {
      languageCriteria.push({ resourceName: c.resourceName, languageConstant: c.language.languageConstant, level: "adGroup" });
    }
  }
  const scheduleCriteria: TargetingState["scheduleCriteria"] = [];
  for (const r of campaignCriteriaRows) {
    const c = r.campaignCriterion;
    if (c?.resourceName && c.type === "LANGUAGE" && c.language?.languageConstant) {
      languageCriteria.push({ resourceName: c.resourceName, languageConstant: c.language.languageConstant, level: "campaign" });
    } else if (c?.resourceName && c.type === "AD_SCHEDULE" && c.adSchedule) {
      scheduleCriteria.push({ resourceName: c.resourceName, ...c.adSchedule });
    }
  }
  return { upgradedTargeting: upgraded !== false, audienceCriterion, languageCriteria, scheduleCriteria };
}

export type AudienceEdit = {
  customerId: string;
  campaignResourceName: string;
  adGroupResourceName: string;
  /** Audience.dimensions[] wanted (lib/audience/google.ts). Empty = everyone. */
  audienceDimensions: unknown[];
  /** languageConstants/<id> wanted. Empty = every language. */
  languageConstants: string[];
  /** US housing ad: age / gender / parental dimensions are refused here too. */
  housing: boolean;
  /** Unique per account: Audience names must be. Campaign id prefix + time. */
  audienceName: string;
};

const HOUSING_FORBIDDEN_DIMENSIONS = ["age", "gender", "parentalStatus"];
// Temp id for an Audience created in the edit request.
const NEW_AUDIENCE = -4;

/**
 * The mutate operations turning `state` into `edit`. Pure, tested. Empty when
 * nothing changes (the caller then skips Google entirely).
 */
export function buildAudienceEditOperations(state: TargetingState, edit: AudienceEdit): unknown[] {
  const dims = edit.audienceDimensions;
  if (edit.housing) {
    const forbidden = dims.some((d) =>
      HOUSING_FORBIDDEN_DIMENSIONS.some((k) => k in (d as Record<string, unknown>)),
    );
    if (forbidden) throw new Error("Refusing a housing edit with age/gender/parental targeting");
  }
  const ops: unknown[] = [];

  if (dims.length > 0 && state.audienceCriterion) {
    ops.push({
      audienceOperation: {
        update: { resourceName: state.audienceCriterion.audience, dimensions: dims },
        updateMask: "dimensions",
      },
    });
  } else if (dims.length > 0) {
    const audience = `customers/${edit.customerId}/audiences/${NEW_AUDIENCE}`;
    ops.push({
      audienceOperation: {
        create: { resourceName: audience, name: edit.audienceName.slice(0, 255), dimensions: dims },
      },
    });
    ops.push({
      adGroupCriterionOperation: { create: { adGroup: edit.adGroupResourceName, audience: { audience } } },
    });
  } else if (state.audienceCriterion) {
    ops.push({ adGroupCriterionOperation: { remove: state.audienceCriterion.resourceName } });
  }

  // Languages: keep what is wanted, remove the rest, create what is missing
  // at the level the campaign's targeting mode puts them.
  const wanted = new Set(edit.languageConstants);
  const have = new Set<string>();
  for (const l of state.languageCriteria) {
    if (wanted.has(l.languageConstant) && !have.has(l.languageConstant)) {
      have.add(l.languageConstant);
      continue;
    }
    ops.push(
      l.level === "campaign"
        ? { campaignCriterionOperation: { remove: l.resourceName } }
        : { adGroupCriterionOperation: { remove: l.resourceName } },
    );
  }
  for (const languageConstant of edit.languageConstants) {
    if (have.has(languageConstant)) continue;
    ops.push(
      state.upgradedTargeting
        ? { adGroupCriterionOperation: { create: { adGroup: edit.adGroupResourceName, language: { languageConstant } } } }
        : {
            campaignCriterionOperation: {
              create: { campaign: edit.campaignResourceName, language: { languageConstant } },
            },
          },
    );
  }
  return ops;
}

/**
 * Operations turning the campaign's AdSchedule criteria into `wanted`
 * ([] = every day, all day). Identical criteria are left alone. Pure, tested.
 */
export function buildScheduleEditOperations(
  state: Pick<TargetingState, "scheduleCriteria">,
  campaignResourceName: string,
  wanted: AdScheduleInfo[],
): unknown[] {
  const want = new Map(wanted.map((w) => [scheduleKey(w), w]));
  const kept = new Set<string>();
  const ops: unknown[] = [];
  for (const c of state.scheduleCriteria) {
    const k = scheduleKey(c);
    if (want.has(k) && !kept.has(k)) {
      kept.add(k);
      continue;
    }
    ops.push({ campaignCriterionOperation: { remove: c.resourceName } });
  }
  for (const [k, adSchedule] of want) {
    if (kept.has(k)) continue;
    ops.push({ campaignCriterionOperation: { create: { campaign: campaignResourceName, adSchedule } } });
  }
  return ops;
}

type MutateResponse = { mutateOperationResponses?: { audienceResult?: { resourceName?: string } }[] };

export type TargetingEdit = {
  /** Who: undefined = leave the audience and languages as they are. */
  audience?: AudienceEdit;
  /** When: undefined = leave; [] = every day, all day. */
  adSchedule?: AdScheduleInfo[];
};

/**
 * Reads the campaign's targeting at Google and applies the edit in one atomic
 * mutate (all or nothing). Returns the Audience now serving (null = none;
 * `currentAudience` when the audience was not part of the edit) and whether
 * anything was sent. Throws GoogleAdsApiError on a refusal; nothing changed
 * at Google then.
 */
export async function applyTargetingEdit(
  ctx: GoogleCtx,
  refs: { customerId: string; campaignResourceName: string; adGroupResourceName: string },
  edit: TargetingEdit,
): Promise<{ audienceResourceName: string | null; changed: boolean }> {
  const state = await fetchTargetingState(ctx, refs);
  const ops = [
    ...(edit.audience ? buildAudienceEditOperations(state, edit.audience) : []),
    ...(edit.adSchedule ? buildScheduleEditOperations(state, refs.campaignResourceName, edit.adSchedule) : []),
  ];
  const current = state.audienceCriterion?.audience ?? null;
  const keep = edit.audience ? (edit.audience.audienceDimensions.length > 0 ? current : null) : current;
  if (ops.length === 0) return { audienceResourceName: keep, changed: false };
  const body = await googleAdsCall<MutateResponse>(`/customers/${ctx.customerId}/googleAds:mutate`, ctx.accessToken, {
    method: "POST",
    loginCustomerId: ctx.loginCustomerId,
    body: { mutateOperations: ops },
  });
  if (edit.audience && edit.audience.audienceDimensions.length > 0 && !state.audienceCriterion) {
    // A new Audience was created: its real name is in the response.
    const created = (body.mutateOperationResponses ?? [])
      .map((r) => r.audienceResult?.resourceName)
      .find((n): n is string => Boolean(n));
    return { audienceResourceName: created ?? null, changed: true };
  }
  return { audienceResourceName: keep, changed: true };
}

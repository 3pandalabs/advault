import { googleAdsCall } from "./client.js";

// Campaign creation. This module is the only place in the codebase that spends
// an advertiser's money, and it is reached from exactly one route
// (POST /campaigns/:id/launch). Keep both of those true.

// Google takes budgets in micros — one millionth of the account currency unit.
// Cents to micros is ×10,000. Doing this conversion in one named function
// rather than inline is deliberate: an off-by-a-thousand here is a 1000x
// overspend on someone's card.
export function centsToMicros(cents: number): number {
  return cents * 10_000;
}

type MutateResponse = { results?: { resourceName?: string }[] };

// Budgets are their own resource and must exist before the campaign that
// references them. Created as non-shared (`explicitlyShared: false`) so one
// advertiser's campaign can never draw down another's budget.
export async function createCampaignBudget(args: {
  accessToken: string;
  customerId: string;
  loginCustomerId?: string | null;
  name: string;
  dailyBudgetCents: number;
}): Promise<string> {
  const body = await googleAdsCall<MutateResponse>(
    `/customers/${args.customerId}/campaignBudgets:mutate`,
    args.accessToken,
    {
      method: "POST",
      loginCustomerId: args.loginCustomerId,
      body: {
        operations: [
          {
            create: {
              // Google requires budget names to be unique within the account.
              // The campaign name alone collides the second time an advertiser
              // reuses it, so the caller passes an already-uniquified name.
              name: args.name,
              amountMicros: String(centsToMicros(args.dailyBudgetCents)),
              deliveryMethod: "STANDARD",
              explicitlyShared: false,
            },
          },
        ],
      },
    },
  );

  const resourceName = body.results?.[0]?.resourceName;
  if (!resourceName) throw new Error("Google Ads returned no budget resource name");
  return resourceName;
}

export async function createVideoCampaign(args: {
  accessToken: string;
  customerId: string;
  loginCustomerId?: string | null;
  name: string;
  budgetResourceName: string;
}): Promise<string> {
  const body = await googleAdsCall<MutateResponse>(
    `/customers/${args.customerId}/campaigns:mutate`,
    args.accessToken,
    {
      method: "POST",
      loginCustomerId: args.loginCustomerId,
      body: {
        operations: [
          {
            create: {
              name: args.name,
              // VIDEO with a REACH goal is the Video Reach campaign shape —
              // the right fit for a local business buying awareness in a few
              // ZIP codes, and the cheapest per impression of the video types.
              advertisingChannelType: "VIDEO",
              advertisingChannelSubType: "VIDEO_REACH_TARGET_FREQUENCY",
              campaignBudget: args.budgetResourceName,
              targetCpm: {},
              // PAUSED, always. A campaign that starts serving the instant the
              // API accepts it would spend before the advertiser has seen it
              // in their own Google Ads account. Enabling is a deliberate
              // second step, and it belongs to the advertiser.
              status: "PAUSED",
            },
          },
        ],
      },
    },
  );

  const resourceName = body.results?.[0]?.resourceName;
  if (!resourceName) throw new Error("Google Ads returned no campaign resource name");
  return resourceName;
}

// Geo targeting. Google identifies places by numeric criterion id, not by ZIP
// code, so each ZIP has to be resolved first — see resolveZipCriteria below.
export async function addLocationTargets(args: {
  accessToken: string;
  customerId: string;
  loginCustomerId?: string | null;
  campaignResourceName: string;
  geoTargetConstants: string[];
  radiusMiles: number;
}): Promise<void> {
  if (args.geoTargetConstants.length === 0) {
    // Guarded here as well as by the campaigns_zips_check constraint: a video
    // campaign with no location criteria targets the entire country, which is
    // the single most expensive way for this app to be wrong.
    throw new Error("Refusing to launch a campaign with no location targets");
  }

  await googleAdsCall(
    `/customers/${args.customerId}/campaignCriteria:mutate`,
    args.accessToken,
    {
      method: "POST",
      loginCustomerId: args.loginCustomerId,
      body: {
        operations: args.geoTargetConstants.map((geoTargetConstant) => ({
          create: {
            campaign: args.campaignResourceName,
            location: { geoTargetConstant },
          },
        })),
      },
    },
  );
}

// Resolves ZIP codes to Google geo target constants. Returns only what Google
// recognised — a typo'd ZIP is dropped rather than failing the launch, and the
// caller reports how many resolved so the advertiser can see it.
export async function resolveZipCriteria(args: {
  accessToken: string;
  customerId: string;
  loginCustomerId?: string | null;
  zipCodes: string[];
  countryCode?: string;
}): Promise<string[]> {
  const body = await googleAdsCall<{
    geoTargetConstantSuggestions?: { geoTargetConstant?: { resourceName?: string } }[];
  }>(`/geoTargetConstants:suggest`, args.accessToken, {
    method: "POST",
    loginCustomerId: args.loginCustomerId,
    body: {
      locale: "en",
      countryCode: args.countryCode ?? "US",
      locationNames: { names: args.zipCodes },
    },
  });

  return (body.geoTargetConstantSuggestions ?? [])
    .map((s) => s.geoTargetConstant?.resourceName)
    .filter((n): n is string => Boolean(n));
}

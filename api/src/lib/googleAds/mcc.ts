import "dotenv/config";
import { googleAdsCall } from "./client.js";
import { googleAdsEnv } from "./env.js";
import { refreshAccessToken } from "./oauth.js";
import { decryptToken } from "../crypto.js";
import type { Currency } from "../pricing/index.js";

// Google Ads Manager Account (MCC) — programmatic child account creation.
//
// This is what lets an advertiser never see Google Ads. AdVault creates a child
// customer under the 3PandaLabs manager account, and campaigns run in it.
//
// ⚠️ THE THING TO UNDERSTAND BEFORE TOUCHING THIS FILE: billing for a child
// account created this way sits on the MANAGER account. 3PandaLabs pays Google
// for every advertiser's spend and recovers it afterwards. That is the entire
// reason lib/wallet exists — a prepaid balance and a nightly auto-pause are
// what bound the org's exposure to roughly one day of each advertiser's daily
// budget instead of an uncapped month.
//
// Never launch a campaign in a managed account without checking the wallet
// first. routes/launch.ts is where that check lives.

// The MCC's own refresh token — one credential for the whole platform, not one
// per advertiser. Stored encrypted at rest like every other Google token; see
// infra/google-ads-setup.md for how to mint it.
const MCC_REFRESH_TOKEN_CIPHERTEXT = process.env.GOOGLE_ADS_MCC_REFRESH_TOKEN_CIPHERTEXT;

export function isMccConfigured(): boolean {
  return Boolean(
    googleAdsEnv.clientId &&
      googleAdsEnv.clientSecret &&
      googleAdsEnv.developerToken &&
      googleAdsEnv.loginCustomerId &&
      MCC_REFRESH_TOKEN_CIPHERTEXT,
  );
}

export class MccNotConfigured extends Error {
  constructor() {
    super("google_ads_mcc_not_configured");
  }
}

/** A short-lived access token acting as the MCC itself. */
export async function mccAccessToken(): Promise<string> {
  if (!isMccConfigured()) throw new MccNotConfigured();
  return refreshAccessToken(decryptToken(MCC_REFRESH_TOKEN_CIPHERTEXT!));
}

export type ProvisionResult = {
  customerId: string;
  resourceName: string;
  managerCustomerId: string;
};

/**
 * Creates a child account under the 3PandaLabs MCC.
 *
 * `currencyCode` and `timeZone` are IMMUTABLE at Google once the account
 * exists — there is no API to change either afterwards. Getting them wrong
 * means the advertiser needs an entirely new account, so they are derived from
 * the user's country at signup and never from a form field they can fat-finger.
 */
export async function createChildAccount(args: {
  descriptiveName: string;
  currency: Currency;
  timeZone: string;
}): Promise<ProvisionResult> {
  if (!isMccConfigured()) throw new MccNotConfigured();

  const managerId = googleAdsEnv.loginCustomerId!.replace(/-/g, "");
  const accessToken = await mccAccessToken();

  const body = await googleAdsCall<{ resourceName?: string }>(
    `/customers/${managerId}:createCustomerClient`,
    accessToken,
    {
      method: "POST",
      loginCustomerId: managerId,
      body: {
        customerClient: {
          // Shown in the MCC's account list. Prefixed so a human scanning the
          // manager account can tell AdVault-created children from any that
          // were linked by hand.
          descriptiveName: `AdVault — ${args.descriptiveName}`.slice(0, 255),
          currencyCode: args.currency,
          timeZone: args.timeZone,
        },
      },
    },
  );

  // Google answers with "customers/<id>" — the child's own id, which is what
  // every later mutate call targets.
  const resourceName = body.resourceName;
  if (!resourceName) throw new Error("Google Ads returned no resource name for the child account");

  const customerId = resourceName.split("/").pop();
  if (!customerId || !/^\d+$/.test(customerId)) {
    throw new Error(`Unexpected child resource name from Google Ads: ${resourceName}`);
  }

  return { customerId, resourceName, managerCustomerId: managerId };
}

// IANA zones. Google validates these, and a bad one fails account creation —
// which is unrecoverable in the sense that the advertiser has to be
// re-provisioned. Kept to the two markets AdVault serves.
export function defaultTimeZone(currency: Currency): string {
  return currency === "INR" ? "Asia/Kolkata" : "America/New_York";
}

/**
 * Spend for a child account, per day, in the account's own currency.
 *
 * Returns micros as Google reports them; the caller converts. Segmented by date
 * because that is what makes the wallet debit idempotent — each (campaign, date)
 * pair becomes one ledger row with a stable externalRef, so a re-run of the
 * sync cannot double-charge.
 */
export async function fetchCampaignSpend(args: {
  accessToken: string;
  customerId: string;
  sinceDate: string; // YYYY-MM-DD
}): Promise<{ campaignResourceName: string; date: string; costMicros: number }[]> {
  const body = await googleAdsCall<{
    results?: {
      campaign?: { resourceName?: string };
      segments?: { date?: string };
      metrics?: { costMicros?: string };
    }[];
  }>(`/customers/${args.customerId}/googleAds:search`, args.accessToken, {
    method: "POST",
    body: {
      query:
        "SELECT campaign.resource_name, segments.date, metrics.cost_micros " +
        "FROM campaign " +
        `WHERE segments.date >= '${args.sinceDate}' ` +
        "AND metrics.cost_micros > 0",
    },
  });

  return (body.results ?? [])
    .filter((r) => r.campaign?.resourceName && r.segments?.date)
    .map((r) => ({
      campaignResourceName: r.campaign!.resourceName!,
      date: r.segments!.date!,
      costMicros: Number(r.metrics?.costMicros ?? 0),
    }));
}

/** Google reports micros (1e6 per unit); wallets hold minor units (1e2). */
export function microsToMinor(micros: number): number {
  return Math.round(micros / 10_000);
}

/** Pauses a campaign at Google — the lever the wallet guard pulls when funds run out. */
export async function pauseCampaign(args: {
  accessToken: string;
  customerId: string;
  campaignResourceName: string;
}): Promise<void> {
  await googleAdsCall(`/customers/${args.customerId}/campaigns:mutate`, args.accessToken, {
    method: "POST",
    body: {
      operations: [{ update: { resourceName: args.campaignResourceName, status: "PAUSED" }, updateMask: "status" }],
    },
  });
}

/** Resumes a paused campaign — used when a top-up refills a dry wallet. */
export async function enableCampaign(args: {
  accessToken: string;
  customerId: string;
  campaignResourceName: string;
}): Promise<void> {
  await googleAdsCall(`/customers/${args.customerId}/campaigns:mutate`, args.accessToken, {
    method: "POST",
    body: {
      operations: [{ update: { resourceName: args.campaignResourceName, status: "ENABLED" }, updateMask: "status" }],
    },
  });
}

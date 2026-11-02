import { googleAdsCall } from "./client.js";

// Budget maths and postal-code lookup. The launch itself — the only thing in
// this codebase that spends money — is one atomic request built in
// demandGen.ts and sent from exactly one route (POST /campaigns/:id/launch).

// Google takes budgets in micros — one millionth of the account currency unit.
// Cents to micros is ×10,000. Doing this conversion in one named function
// rather than inline is deliberate: an off-by-a-thousand here is a 1000x
// overspend on someone's card.
export function centsToMicros(cents: number): number {
  return cents * 10_000;
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

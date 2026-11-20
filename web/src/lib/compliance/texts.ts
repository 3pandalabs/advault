// Browser mirror of api/src/lib/compliance/texts.ts. The API is the real
// boundary; the block between the <shared> markers is kept word for word by
// api/src/lib/compliance/mirror.test.ts. Edit the API copy, then this.

// between the <shared> markers, word for word, lib/compliance/mirror.test.ts).
// Wording is market-neutral (US and India): no FTC/ASCI names here.

// <shared>
export const ATTESTATION_VERSION = "2026-11-20.v1";

export const ATTESTATION_ACCURACY_TEXT =
  "I confirm all information and claims in this ad are true, accurate, and lawful, and I accept responsibility for them.";

export const ATTESTATION_MEDIA_TEXT =
  "I own or have rights to all photos/media uploaded, and have consent from any person shown.";

/** The website-ownership tick on "Make me a website" (recorded as action 'website'). */
export const WEBSITE_OWNERSHIP_TEXT =
  "I run this business, the details are accurate, and I agree to the SiteVault terms. The website is public.";

export const WEBSITE_OWNERSHIP_VERSION = "2026-11-15.v1";

/** The Terms of Service version in force (matches the effective date on /terms). */
export const TERMS_VERSION = "2026-11-19";

/** What the client sends with every order, generate, redo, upload and launch. */
export type Attestation = { accuracy: true; media: true; version: string };

/** The two sentences exactly as shown, as stored in ad_attestations.exact_text_snapshot. */
export function attestationSnapshotText(): string {
  return `${ATTESTATION_ACCURACY_TEXT}\n${ATTESTATION_MEDIA_TEXT}`;
}
// </shared>

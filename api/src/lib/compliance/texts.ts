// The exact words a client agrees to (2026-11-20). ad_attestations stores the
// version AND the exact text of every tick, so changing a sentence means a new
// version string, never an edit in place. TERMS_VERSION is the Terms of
// Service version /auth/me compares against terms_acceptances: bump it (and
// the date on /terms) when the terms change, and every user is asked to accept
// again before ordering, generating or launching (409 terms_not_accepted).
//
// Mirrored for the browser in web/src/lib/compliance/texts.ts (the block
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
export const TERMS_VERSION = "2026-11-21";

/** What the client sends with every order, generate, redo, upload and launch. */
export type Attestation = { accuracy: true; media: true; version: string };

/** The two sentences exactly as shown, as stored in ad_attestations.exact_text_snapshot. */
export function attestationSnapshotText(): string {
  return `${ATTESTATION_ACCURACY_TEXT}\n${ATTESTATION_MEDIA_TEXT}`;
}
// </shared>

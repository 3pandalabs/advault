import type { AdScript } from "./schema.js";

// Deterministic script used when ANTHROPIC_API_KEY is unset, or when the model
// call fails. Not a placeholder to be replaced later — it is the reason a
// missing or flaky integration key cannot break the wizard.
//
// It makes no claim the advertiser didn't supply, for exactly the same reason
// the system prompt forbids it.
//
// THE RULE THIS FILE GETS WRONG IF YOU LET IT: the offer is the ad. A local
// business does not advertise "we exist", it advertises "30% off till Sunday".
// The first version of this template ignored `offerDetails` entirely and built
// every script from businessName, businessCategory and a postcode — so a salon
// and a dentist in the same PIN code got near-identical videos, and the single
// most persuasive thing the advertiser told us was dropped on the floor.
// Dogfooding it on 3PandaLabs produced "Looking for Software studio near
// 94107?" while a paragraph of real detail sat unused in the input.
//
// If you change anything here, keep these two properties:
//   1. `offerDetails` leads when it exists.
//   2. A raw postcode never reaches the viewer's ears or eyes.

const SCENE_SECONDS = 4;

/**
 * A postcode is not a place.
 *
 * Nobody says "near 560001" — they say "in Koramangala". We have no
 * postcode-to-neighbourhood data, and inventing one would put a wrong place
 * name in a paid advertisement. So the honest fallback is to say "nearby" and
 * let the geo targeting do the work it is already doing: the ad is ONLY shown
 * to people in that radius, which makes "near you" true by construction and
 * "near 94107" both redundant and strange.
 */
function areaPhrase(): string {
  return "near you";
}

/**
 * First clause of the advertiser's own offer text, trimmed to something that
 * fits on screen.
 *
 * Cut on sentence and clause boundaries rather than a hard character slice, so
 * a caption reads as a phrase instead of ending mid-word. Their words, never
 * ours — we are shortening what they wrote, not writing copy on their behalf.
 */
function offerHeadline(offerDetails: string | null | undefined, maxChars = 60): string | null {
  if (!offerDetails) return null;
  const cleaned = offerDetails.replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  if (cleaned.length <= maxChars) return cleaned;

  const cut = cleaned.slice(0, maxChars);
  const boundary = Math.max(cut.lastIndexOf("."), cut.lastIndexOf(","), cut.lastIndexOf(" — "));
  const head = boundary > 20 ? cut.slice(0, boundary) : cut.slice(0, cut.lastIndexOf(" "));
  return head.replace(/[,.\s]+$/, "");
}

/** One sentence of the offer, for the voiceover, where there is more room. */
function offerSentence(offerDetails: string | null | undefined): string | null {
  if (!offerDetails) return null;
  const cleaned = offerDetails.replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  const firstSentence = cleaned.split(/(?<=[.!?])\s/)[0] ?? cleaned;
  return firstSentence.length > 160 ? `${firstSentence.slice(0, 157).trimEnd()}…` : firstSentence;
}

export function buildFallbackScript(input: {
  businessName: string;
  businessCategory: string;
  callToAction: string;
  offerDetails?: string | null;
  targetZipCodes: string[];
  assetCount: number;
}): AdScript {
  const area = areaPhrase();
  const headline = offerHeadline(input.offerDetails);
  const spoken = offerSentence(input.offerDetails);

  // Two scenes minimum (the schema's floor), at most three — past that the
  // template starts repeating itself, which reads worse than a shorter ad.
  const sceneCount = Math.min(Math.max(input.assetCount, 2), 3);

  // The offer leads when there is one. Without it there is genuinely nothing
  // specific to say, and the category line is the honest fallback rather than
  // an invented benefit.
  const hook = headline ?? `${input.businessName} — ${input.businessCategory} ${area}`;

  const captions = headline
    ? [headline, input.businessName, input.callToAction]
    : [input.businessName, `${input.businessCategory} ${area}`, input.callToAction];

  const voiceover = spoken
    ? `${spoken} ${input.businessName}, ${area}. ${input.callToAction}.`
    : `${input.businessName} — ${input.businessCategory} ${area}. ${input.callToAction}.`;

  return {
    hook,
    scenes: Array.from({ length: sceneCount }, (_, i) => ({
      // Modulo so a two-photo upload still fills three scenes rather than
      // pointing at an asset index that doesn't exist.
      assetIndex: i % Math.max(input.assetCount, 1),
      caption: captions[i] ?? input.businessName,
      durationSeconds: SCENE_SECONDS,
    })),
    callToAction: input.callToAction,
    endCardText: input.businessName,
    voiceoverText: voiceover,
  };
}

import type { AdScript } from "./schema.js";

// Deterministic script used when ANTHROPIC_API_KEY is unset, or when the model
// call fails. Not a placeholder to be replaced later — it is the reason a
// missing or flaky integration key cannot break the wizard. The copy is
// formulaic, but it is honest, renders identically, and can be edited by the
// advertiser afterwards.
//
// It makes no claim the advertiser didn't supply, for exactly the same reason
// the system prompt forbids it.

const SCENE_SECONDS = 4;

export function buildFallbackScript(input: {
  businessName: string;
  businessCategory: string;
  callToAction: string;
  targetZipCodes: string[];
  assetCount: number;
}): AdScript {
  const area = input.targetZipCodes[0] ?? "your area";
  // Two scenes minimum (the schema's floor), at most three — past that the
  // template starts repeating itself, which reads worse than a shorter ad.
  const sceneCount = Math.min(Math.max(input.assetCount, 2), 3);

  const captions = [
    `${input.businessName}`,
    `Serving ${area} and nearby`,
    `${input.businessCategory} you can book today`,
  ];

  return {
    hook: `Looking for ${input.businessCategory} near ${area}?`,
    scenes: Array.from({ length: sceneCount }, (_, i) => ({
      // Modulo so a two-photo upload still fills three scenes rather than
      // pointing at an asset index that doesn't exist.
      assetIndex: i % Math.max(input.assetCount, 1),
      caption: captions[i] ?? input.businessName,
      durationSeconds: SCENE_SECONDS,
    })),
    callToAction: input.callToAction,
    endCardText: input.businessName,
    voiceoverText: `Looking for ${input.businessCategory} near ${area}? ${input.businessName} serves ${area} and the surrounding neighbourhoods. ${input.callToAction}.`,
  };
}

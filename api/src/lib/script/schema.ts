import { z } from "zod";

// The generated ad script. Written whole by the generator, read whole by the
// renderer, stored as jsonb on `creatives.script`.
//
// Durations are per-scene seconds. The renderer trusts these to lay out the
// timeline, so they are constrained here rather than in the renderer — a bad
// duration should fail at generation time, where an advertiser can regenerate,
// not at encode time, where all they see is a failed render.

export const sceneSchema = z.object({
  // Which uploaded asset backs this scene, as an index into the creative's
  // sourceAssetKeys. An index rather than a key so the model never has to
  // reproduce an R2 key correctly — and so it cannot invent one.
  assetIndex: z.number().int().min(0).max(4),
  // The on-screen text. Short by necessity: this is burned into video at a
  // size that must be legible on a phone held at arm's length.
  caption: z.string().min(1).max(60),
  durationSeconds: z.number().min(1).max(8),
});

export const adScriptSchema = z.object({
  // The opening line. Carries the whole ad on YouTube, where the viewer can
  // skip after five seconds.
  hook: z.string().min(1).max(80),
  scenes: z.array(sceneSchema).min(2).max(5),
  // Closing frame: what to do and how to reach the business.
  callToAction: z.string().min(1).max(40),
  endCardText: z.string().min(1).max(60),
  // Voiceover/subtitle copy for the whole spot, if one is ever added. Stored
  // now so regenerating isn't required when narration ships.
  voiceoverText: z.string().min(1).max(600),
});

export type AdScript = z.infer<typeof adScriptSchema>;
export type AdScene = z.infer<typeof sceneSchema>;

export function totalDurationSeconds(script: AdScript): number {
  return Math.round(script.scenes.reduce((sum, s) => sum + s.durationSeconds, 0));
}

// JSON Schema handed to the Messages API's structured-output format. Written
// by hand rather than derived from the Zod schema: the API's supported subset
// excludes the numeric constraints above (`minimum`/`maximum`/`minItems`), so a
// generated schema would be silently stripped of exactly the bounds that
// matter. The Zod schema still validates the response — this shape only has to
// pin the structure, and `adScriptSchema.parse()` enforces the rest.
export const AD_SCRIPT_JSON_SCHEMA = {
  type: "object",
  properties: {
    hook: { type: "string", description: "Opening line, under 80 characters." },
    scenes: {
      type: "array",
      description: "Two to five scenes, in order.",
      items: {
        type: "object",
        properties: {
          assetIndex: {
            type: "integer",
            description: "0-based index into the advertiser's uploaded photos.",
          },
          caption: { type: "string", description: "On-screen text, under 60 characters." },
          durationSeconds: { type: "number", description: "Between 1 and 8 seconds." },
        },
        required: ["assetIndex", "caption", "durationSeconds"],
        additionalProperties: false,
      },
    },
    callToAction: { type: "string", description: "Under 40 characters, e.g. 'Call now'." },
    endCardText: { type: "string", description: "Closing frame text, under 60 characters." },
    voiceoverText: { type: "string", description: "Narration for the whole spot." },
  },
  required: ["hook", "scenes", "callToAction", "endCardText", "voiceoverText"],
  additionalProperties: false,
} as const;

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

// The offer sticker of the template ad (render/template, 2026-11-13): a big
// round badge, a bar under it and a small tag, plus up to two benefit chips.
// Optional so scripts written before it existed still render (the ffmpeg
// layout ignores it). Same no-invented-claims rule as everything else: the
// badge carries a price or discount ONLY when the advertiser wrote one.
export const stickerSchema = z.object({
  badge: z.string().min(1).max(10),
  headline: z.string().min(1).max(24),
  tagline: z.string().min(1).max(26),
  benefits: z.array(z.string().min(1).max(28)).max(2),
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
  sticker: stickerSchema.optional(),
  // Set by lib/creatives/generate.ts from the advertiser's choices, never by
  // the model: photos marked as showing people (motion clips go to these
  // first, render/worker.ts) and the agent's own photo (real estate; shown on
  // the template's end card, render/template.ts).
  peopleIndexes: z.array(z.number().int().min(0).max(4)).max(5).optional(),
  portraitIndex: z.number().int().min(0).max(4).optional(),
});

export type AdScript = z.infer<typeof adScriptSchema>;
export type AdScene = z.infer<typeof sceneSchema>;
export type AdSticker = z.infer<typeof stickerSchema>;

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
    voiceoverText: {
      type: "string",
      description:
        "Narration for the whole spot, about 25 words (8-10 seconds spoken), starting with one ElevenLabs audio tag such as [warmly] or [cheerfully].",
    },
    sticker: {
      type: "object",
      description: "The offer sticker shown big at the start of the video.",
      properties: {
        badge: {
          type: "string",
          description:
            "Up to 10 characters, uppercase. The advertiser's own price or discount (e.g. '$10 OFF', '$49') ONLY if they wrote one; otherwise a short non-claim word such as 'NEW', 'LOCAL' or 'BOOK NOW'.",
        },
        headline: {
          type: "string",
          description: "Up to 24 characters, uppercase: what the offer is for, or the service (e.g. 'YOUR FIRST CUT', 'DRAIN CLEANING').",
        },
        tagline: {
          type: "string",
          description:
            "Up to 26 characters, uppercase: the deadline or condition the advertiser gave (e.g. 'THIS MONTH ONLY'); otherwise 'NEAR YOU'.",
        },
        benefits: {
          type: "array",
          description: "Zero to two short facts the advertiser stated, up to 28 characters each. Never invented.",
          items: { type: "string" },
        },
      },
      required: ["badge", "headline", "tagline", "benefits"],
      additionalProperties: false,
    },
  },
  required: ["hook", "scenes", "callToAction", "endCardText", "voiceoverText", "sticker"],
  additionalProperties: false,
} as const;

function fit(s: unknown, max: number, upper: boolean): string | undefined {
  if (typeof s !== "string") return undefined;
  let t = s.replace(/\s+/g, " ").trim();
  if (upper) t = t.toUpperCase();
  if (t.length <= max) return t || undefined;
  const cut = t.slice(0, max + 1);
  const space = cut.lastIndexOf(" ");
  return (space > max / 2 ? cut.slice(0, space) : t.slice(0, max)).trim();
}

/**
 * Trims the model's sticker to the template's limits before validation, so
 * one long benefit doesn't throw away an otherwise good script. A sticker
 * that can't be repaired is dropped (the script still renders without it).
 */
export function normalizeScriptJson(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const r = raw as Record<string, unknown>;
  const st = r.sticker as Record<string, unknown> | undefined;
  if (!st || typeof st !== "object") return raw;
  const sticker = {
    badge: fit(st.badge, 10, true),
    headline: fit(st.headline, 24, true),
    tagline: fit(st.tagline, 26, true),
    benefits: (Array.isArray(st.benefits) ? st.benefits : [])
      .map((b) => fit(b, 28, false))
      .filter((b): b is string => !!b)
      .slice(0, 2),
  };
  const ok = sticker.badge && sticker.headline && sticker.tagline;
  return { ...r, sticker: ok ? sticker : undefined };
}

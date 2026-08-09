import { z } from "zod";

// What Claude returns for a cinematic ad.
//
// Note what is ABSENT: durations. The model proposes what is in each shot; the
// price list decides how many seconds are bought and planShotDurations() hands
// them out. Letting the model choose would make a fixed-price product carry a
// variable vendor bill, and a chatty response would quietly eat the margin.

export const cinematicShotSchema = z.object({
  /**
   * Sent verbatim to a text-to-video model. Long enough to specify light, lens
   * and motion — that specificity is the entire difference between showreel
   * footage and mush — and hard-capped because vendors truncate silently.
   */
  visualPrompt: z.string().min(20).max(400),
  /**
   * Burnt in by ffmpeg over this shot, from the advertiser's own words. This
   * is where a factual claim is ALLOWED to live, because we render it
   * pixel-exact rather than asking a video model to draw letters.
   */
  caption: z.string().max(60).nullable(),
});

export const cinematicBriefSchema = z.object({
  shots: z.array(cinematicShotSchema).min(1).max(4),
  voiceoverText: z.string().min(1).max(600),
  closingText: z.string().min(1).max(60),
  callToAction: z.string().min(1).max(40),
});

export type CinematicBriefDraft = z.infer<typeof cinematicBriefSchema>;

// Mirrors AD_SCRIPT_JSON_SCHEMA: the API's structured-output subset pins the
// shape, Zod above enforces the bounds it cannot express.
export const CINEMATIC_BRIEF_JSON_SCHEMA = {
  type: "object",
  properties: {
    shots: {
      type: "array",
      items: {
        type: "object",
        properties: {
          visualPrompt: { type: "string" },
          caption: { type: ["string", "null"] },
        },
        required: ["visualPrompt", "caption"],
        additionalProperties: false,
      },
    },
    voiceoverText: { type: "string" },
    closingText: { type: "string" },
    callToAction: { type: "string" },
  },
  required: ["shots", "voiceoverText", "closingText", "callToAction"],
  additionalProperties: false,
} as const;

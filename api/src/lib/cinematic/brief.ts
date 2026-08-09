import Anthropic from "@anthropic-ai/sdk";
import { scriptEnv } from "../script/env.js";
import { CINEMATIC_BRIEF_SYSTEM_PROMPT, buildCinematicUserPrompt } from "./prompt.js";
import { CINEMATIC_BRIEF_JSON_SCHEMA, cinematicBriefSchema } from "./schema.js";
import {
  planShotDurations,
  rejectBrief,
  rejectVisualPrompt,
  type CinematicBrief,
  type VisualRejection,
} from "./policy.js";
import type { AddOn } from "../pricing/index.js";

let client: Anthropic | undefined;
function getClient(): Anthropic {
  if (!scriptEnv.apiKey) throw new Error("ANTHROPIC_API_KEY is not configured");
  if (!client) client = new Anthropic({ apiKey: scriptEnv.apiKey });
  return client;
}

export type BriefInput = {
  businessName: string;
  businessCategory: string;
  description: string;
  offerDetails?: string | null;
  callToAction: string;
  aspectRatio: "16:9" | "9:16";
  addOn: AddOn;
  realAssetCount: number;
  closingPhotoHint?: string | null;
};

export class CinematicBriefError extends Error {
  constructor(
    message: string,
    readonly code:
      | "not_configured"
      | "model_refused"
      | "no_response"
      | "malformed"
      | "unsafe_after_retries",
  ) {
    super(message);
    this.name = "CinematicBriefError";
  }
}

// Two attempts, and the second one is TOLD what was wrong with the first.
//
// A rejected visual costs one Claude call — a fraction of a cent. A failed
// cinematic order costs a refund on a ₹2,999 sale plus the trust of a customer
// who paid for the good version. So it is worth one round of self-correction
// before giving up, and not worth more than that: a model that reaches for a
// price twice in a row is not going to stop on the third try, and by then the
// advertiser is watching a spinner.
const MAX_BRIEF_ATTEMPTS = 2;

/**
 * Turn what the advertiser typed into shot prompts a video model can use.
 *
 * UNLIKE generateScript(), this deliberately has NO fallback and throws.
 *
 * That asymmetry is the point. A fallback script keeps a free wizard working
 * when a key is missing, and formulaic copy is better than a dead end. But a
 * fallback CINEMATIC brief would produce exactly the generic, template-shaped
 * ad this product exists to not be — and the advertiser has already paid for
 * the other thing. Failing here routes to a refund, which is the honest
 * outcome; silently shipping a downgrade is not.
 */
export async function generateCinematicBrief(
  input: BriefInput,
  log?: (msg: string, extra?: unknown) => void,
): Promise<CinematicBrief> {
  if (!scriptEnv.apiKey) {
    throw new CinematicBriefError(
      "ANTHROPIC_API_KEY is not configured; cinematic ads cannot be produced",
      "not_configured",
    );
  }

  const durations = planShotDurations(input.addOn.generatedSeconds);
  const userPrompt = buildCinematicUserPrompt({
    ...input,
    shotCount: durations.length,
    totalSeconds: durations.reduce((a, b) => a + b, 0),
  });

  let lastRejection: VisualRejection | null = null;

  for (let attempt = 0; attempt < MAX_BRIEF_ATTEMPTS; attempt++) {
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: userPrompt }];
    if (lastRejection) {
      messages.push({
        role: "user",
        content:
          `Your previous shot descriptions were rejected. One of them contained "${lastRejection.match}", ` +
          (lastRejection.reason === "on_screen_text"
            ? `which would put rendered text or a text surface in the frame.`
            : `which is a factual claim.`) +
          ` Rewrite every shot as pure atmosphere — light, texture, materials, hands, motion. Move the fact into the caption or voiceover, where it belongs.`,
      });
    }

    const response = await getClient().messages.create({
      model: scriptEnv.model,
      max_tokens: 4096,
      output_config: {
        // Higher than the ad-script generator's "low": this is a paid artefact
        // and the specificity of the cinematography is what the customer is
        // actually buying. A vague prompt produces vague footage.
        effort: "medium",
        format: { type: "json_schema", schema: CINEMATIC_BRIEF_JSON_SCHEMA },
      },
      system: CINEMATIC_BRIEF_SYSTEM_PROMPT,
      messages,
    });

    if (response.stop_reason === "refusal") {
      throw new CinematicBriefError("the model declined to write this brief", "model_refused");
    }

    const text = response.content.find((b) => b.type === "text")?.text;
    if (!text) throw new CinematicBriefError("the model returned no text block", "no_response");

    const parsed = cinematicBriefSchema.safeParse(JSON.parse(text));
    if (!parsed.success) {
      log?.("cinematic brief failed schema validation", parsed.error);
      throw new CinematicBriefError("the model returned an unusable brief", "malformed");
    }

    // Durations come from the price list, never the model — see schema.ts.
    // Extra shots are dropped rather than paid for.
    const brief: CinematicBrief = {
      shots: parsed.data.shots.slice(0, durations.length).map((shot, i) => ({
        prompt: shot.visualPrompt,
        seconds: durations[i],
        caption: shot.caption,
      })),
      voiceoverText: parsed.data.voiceoverText,
      closingText: parsed.data.closingText,
      callToAction: parsed.data.callToAction,
    };

    const rejection = rejectBrief({
      brief,
      addOn: input.addOn,
      realAssetCount: input.realAssetCount,
    });

    if (!rejection) return brief;

    // Only an unsafe visual is worth another attempt — the others are our bug
    // or the caller's, and re-asking the model would not fix either.
    if (rejection.reason !== "unsafe_visual") {
      log?.("cinematic brief rejected", rejection);
      throw new CinematicBriefError(`brief rejected: ${rejection.reason}`, "malformed");
    }

    lastRejection = rejection.detail;
    log?.("cinematic brief had an unsafe visual; retrying with feedback", {
      attempt: attempt + 1,
      shotIndex: rejection.shotIndex,
      ...rejection.detail,
    });
  }

  throw new CinematicBriefError(
    `the model kept putting claims or text in the footage (last: "${lastRejection?.match}")`,
    "unsafe_after_retries",
  );
}

/** Exposed for the dashboard preview, which shows the prompts before paying. */
export { rejectVisualPrompt };

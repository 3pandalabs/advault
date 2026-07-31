import Anthropic from "@anthropic-ai/sdk";
import { buildFallbackScript } from "./fallback.js";
import { scriptEnv } from "./env.js";
import { AD_SCRIPT_SYSTEM_PROMPT, buildAdScriptUserPrompt } from "./prompt.js";
import { AD_SCRIPT_JSON_SCHEMA, adScriptSchema, type AdScript } from "./schema.js";

let client: Anthropic | undefined;
function getClient(): Anthropic {
  if (!scriptEnv.apiKey) throw new Error("ANTHROPIC_API_KEY is not configured");
  if (!client) client = new Anthropic({ apiKey: scriptEnv.apiKey });
  return client;
}

export type ScriptSource = "ai" | "fallback";
export type GenerateScriptResult = { script: AdScript; source: ScriptSource };

export type GenerateScriptInput = {
  businessName: string;
  businessCategory: string;
  callToAction: string;
  offerDetails?: string | null;
  targetZipCodes: string[];
  radiusMiles: number;
  aspectRatio: "16:9" | "9:16";
  assetCount: number;
};

// Structured outputs rather than tool use: there is one shape to return and no
// tool to call, so `output_config.format` says exactly that. It also means the
// response's first text block is guaranteed-parseable JSON instead of prose
// that happens to contain some.
//
// NEVER throws. A model outage, a malformed response, a rate limit — every one
// of them falls back to the deterministic template and reports source:
// "fallback". The alternative is an advertiser who uploaded five photos and
// filled in a wizard being told to try again later, which is a far worse
// failure than formulaic copy they can edit.
export async function generateScript(
  input: GenerateScriptInput,
  log?: (msg: string, err?: unknown) => void,
): Promise<GenerateScriptResult> {
  const fallback = (): GenerateScriptResult => ({
    script: buildFallbackScript(input),
    source: "fallback",
  });

  if (!scriptEnv.apiKey) {
    log?.("ANTHROPIC_API_KEY unset — using the deterministic script template");
    return fallback();
  }

  try {
    const response = await getClient().messages.create({
      model: scriptEnv.model,
      // Generous relative to the ~200 tokens of JSON this returns, because
      // thinking is on by default on Opus 5 and max_tokens caps thinking plus
      // response text together. A tight limit here truncates the JSON.
      max_tokens: 4096,
      // Short marketing copy from a fully-specified brief: this is not a
      // reasoning-heavy task, and low effort keeps the wizard responsive.
      output_config: {
        effort: "low",
        format: { type: "json_schema", schema: AD_SCRIPT_JSON_SCHEMA },
      },
      // Stable across every advertiser, so it caches. Everything specific to
      // this business is in the user turn below.
      system: AD_SCRIPT_SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildAdScriptUserPrompt(input) }],
    });

    // A safety decline arrives as a normal 200 with an empty content array —
    // reading content[0] without this check throws on exactly the requests
    // most worth handling gracefully.
    if (response.stop_reason === "refusal") {
      log?.("script generation refused by the model — using the template instead");
      return fallback();
    }

    const text = response.content.find((b) => b.type === "text")?.text;
    if (!text) {
      log?.("script generation returned no text block");
      return fallback();
    }

    // The schema pins the structure; Zod enforces the bounds the API's schema
    // subset can't express (caption lengths, scene counts, durations). A model
    // that returns a 200-character caption is not usable output — the renderer
    // would burn text off the edge of the frame — so it takes the fallback.
    const parsed = adScriptSchema.safeParse(JSON.parse(text));
    if (!parsed.success) {
      log?.("script generation returned an out-of-bounds script", parsed.error);
      return fallback();
    }

    // Clamp rather than reject: an index past the end of the uploaded set is a
    // one-field mistake in an otherwise good script, and the renderer needs a
    // valid index more than this needs to be strict.
    const script: AdScript = {
      ...parsed.data,
      scenes: parsed.data.scenes.map((s) => ({
        ...s,
        assetIndex: Math.min(s.assetIndex, Math.max(input.assetCount - 1, 0)),
      })),
    };

    return { script, source: "ai" };
  } catch (err) {
    log?.("script generation failed — using the template instead", err);
    return fallback();
  }
}

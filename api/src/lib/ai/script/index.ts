import "dotenv/config";
import { generateScript as generateWithClaude } from "../../script/generate.js";
import type { GenerateScriptInput, GenerateScriptResult } from "../../script/generate.js";
import { buildFallbackScript } from "../../script/fallback.js";
import { AD_SCRIPT_JSON_SCHEMA, adScriptSchema } from "../../script/schema.js";
import { AD_SCRIPT_SYSTEM_PROMPT, buildAdScriptUserPrompt } from "../../script/prompt.js";

// Script generation, now behind a provider switch.
//
// Claude stays the default: it is already integrated, tested, and the only one
// of these with a deterministic fallback path proven in production. DeepSeek and
// OpenAI are alternates for cost, not replacements — both speak the
// OpenAI-compatible chat-completions shape, so one adapter covers them.
//
// The contract every provider inherits from the Claude implementation and must
// not break: **this never throws**. A model outage falls back to the
// deterministic template and reports `source: "fallback"`. An advertiser who has
// already uploaded photos and filled in a wizard must not be told to come back
// later because a vendor is down.

export type ScriptProviderName = "claude" | "deepseek" | "openai";

const OPENAI_COMPATIBLE: Record<
  Exclude<ScriptProviderName, "claude">,
  { base: string; key?: string; model: string }
> = {
  deepseek: {
    base: process.env.DEEPSEEK_API_BASE ?? "https://api.deepseek.com/v1",
    key: process.env.DEEPSEEK_API_KEY,
    model: process.env.DEEPSEEK_MODEL ?? "deepseek-chat",
  },
  openai: {
    base: process.env.OPENAI_API_BASE ?? "https://api.openai.com/v1",
    key: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
  },
};

function selected(): ScriptProviderName {
  const p = process.env.SCRIPT_PROVIDER as ScriptProviderName | undefined;
  if (p === "deepseek" || p === "openai") {
    return OPENAI_COMPATIBLE[p].key ? p : "claude";
  }
  return "claude";
}

async function generateWithOpenAiCompatible(
  provider: Exclude<ScriptProviderName, "claude">,
  input: GenerateScriptInput,
  log?: (msg: string, err?: unknown) => void,
): Promise<GenerateScriptResult> {
  const cfg = OPENAI_COMPATIBLE[provider];
  const fallback = (): GenerateScriptResult => ({
    script: buildFallbackScript(input),
    source: "fallback",
  });

  try {
    const res = await fetch(`${cfg.base}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: cfg.model,
        // json_schema mode where available; both vendors honour it, and it is
        // the equivalent of the output_config.format used on the Claude path.
        response_format: {
          type: "json_schema",
          json_schema: { name: "ad_script", schema: AD_SCRIPT_JSON_SCHEMA, strict: true },
        },
        messages: [
          { role: "system", content: AD_SCRIPT_SYSTEM_PROMPT },
          { role: "user", content: buildAdScriptUserPrompt(input) },
        ],
      }),
    });

    if (!res.ok) {
      log?.(`${provider} script generation failed: ${res.status}`);
      return fallback();
    }

    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const text = body.choices?.[0]?.message?.content;
    if (!text) return fallback();

    // Same bounds enforcement as the Claude path: the JSON schema pins the
    // structure, Zod enforces the caption lengths and durations the schema
    // subset cannot express. A 200-character caption would render off-frame.
    const parsed = adScriptSchema.safeParse(JSON.parse(text));
    if (!parsed.success) {
      log?.(`${provider} returned an out-of-bounds script`, parsed.error);
      return fallback();
    }

    const script = {
      ...parsed.data,
      scenes: parsed.data.scenes.map((s) => ({
        ...s,
        assetIndex: Math.min(s.assetIndex, Math.max(input.assetCount - 1, 0)),
      })),
    };
    return { script, source: "ai" };
  } catch (err) {
    log?.(`${provider} script generation threw`, err);
    return fallback();
  }
}

export function scriptProviderName(): ScriptProviderName {
  return selected();
}

export function generateScript(
  input: GenerateScriptInput,
  log?: (msg: string, err?: unknown) => void,
): Promise<GenerateScriptResult> {
  const provider = selected();
  return provider === "claude"
    ? generateWithClaude(input, log)
    : generateWithOpenAiCompatible(provider, input, log);
}

export type { GenerateScriptInput, GenerateScriptResult };

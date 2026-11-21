// The re-cut's text (lib/offerSwap). A SMALL model edit of the launched
// script, constrained to the offer parts (hook, captions, end card text,
// voiceover, sticker); everything else is copied from the launched script by
// mergeRecut. Any failure — no key, a refusal, a malformed answer — means the
// deterministic re-cut, never a failed change.

import Anthropic from "@anthropic-ai/sdk";
import { scriptEnv } from "../script/env.js";
import type { AdScript } from "../script/schema.js";
import { deterministicRecut, mergeRecut, untilTag, validRecutText } from "./policy.js";

export const RECUT_PROMPT_VERSION = "2026-11-21.offer-recut-v1";

const SYSTEM = `You edit the text of an existing short video ad for a small local business. The video, photos, scene order, narrator and motion stay exactly as they are; you only rewrite the words that carry the OFFER.

Rules:
- Use only the business owner's own offer words. Never invent prices, discounts, deadlines, statistics, reviews, awards, rankings, guarantees or superlatives.
- If there is NO new offer, remove every price, discount, deal and deadline from the text, and keep the rest of the message.
- Keep the same number of captions, in the same order; keep the tone of the original. Captions are short (under 60 characters), read on a phone.
- The voiceover is about 25 words and starts with the same audio tag as the original (e.g. [warmly]).
- The sticker badge (max 10 characters) shows the owner's price or discount only if they wrote one, otherwise a plain word like OFFER, NEW or LOCAL. Headline max 24, tagline max 26 (the deadline when given), up to two benefits the owner stated.
- Real estate follows the US Fair Housing Act: never say or imply who a home suits or who is welcome.`;

const SCHEMA = {
  type: "object",
  properties: {
    hook: { type: "string" },
    captions: { type: "array", items: { type: "string" } },
    endCardText: { type: "string" },
    voiceoverText: { type: "string" },
    sticker: {
      type: "object",
      properties: {
        badge: { type: "string" },
        headline: { type: "string" },
        tagline: { type: "string" },
        benefits: { type: "array", items: { type: "string" } },
      },
      required: ["badge", "headline", "tagline", "benefits"],
      additionalProperties: false,
    },
  },
  required: ["hook", "captions", "endCardText", "voiceoverText", "sticker"],
  additionalProperties: false,
} as const;

let client: Anthropic | undefined;

export type RecutInput = {
  base: AdScript;
  offer: string | null;
  endsAt: Date | null;
  businessName: string;
  businessCategory: string;
  callToAction: string;
};

export async function recutScript(
  input: RecutInput,
  log?: (msg: string, err?: unknown) => void,
): Promise<{ script: AdScript; source: "ai" | "fallback" }> {
  const fallback = () => ({ script: deterministicRecut(input), source: "fallback" as const });
  if (!scriptEnv.apiKey) return fallback();
  try {
    client ??= new Anthropic({ apiKey: scriptEnv.apiKey });
    const original = {
      hook: input.base.hook,
      captions: input.base.scenes.map((s) => s.caption),
      endCardText: input.base.endCardText,
      voiceoverText: input.base.voiceoverText,
      sticker: input.base.sticker ?? null,
    };
    const user = [
      `Business: ${input.businessName} (${input.businessCategory}). Call to action: ${input.callToAction}.`,
      input.offer
        ? `New offer, in the owner's words: "${input.offer}"${input.endsAt ? ` (runs until ${input.endsAt.toISOString().slice(0, 10)}; tagline suggestion "${untilTag(input.endsAt)}")` : ""}.`
        : "There is NO offer now: remove any offer, price, discount or deadline.",
      `The current text (JSON): ${JSON.stringify(original)}`,
      `Return the new text with exactly ${input.base.scenes.length} captions.`,
    ].join("\n\n");
    const response = await client.messages.create({
      model: scriptEnv.model,
      max_tokens: 1500,
      output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
      system: SYSTEM,
      messages: [{ role: "user", content: user }],
    } as Parameters<Anthropic["messages"]["create"]>[0]);
    const msg = response as Anthropic.Message;
    if (msg.stop_reason === "refusal") return fallback();
    const text = msg.content.find((b) => b.type === "text");
    const parsed = text && text.type === "text" ? JSON.parse(text.text) : null;
    if (!validRecutText(parsed, input.base.scenes.length)) {
      log?.("offer re-cut: model text out of shape; using the deterministic re-cut");
      return fallback();
    }
    return { script: mergeRecut(input.base, parsed), source: "ai" };
  } catch (err) {
    log?.("offer re-cut: model call failed; using the deterministic re-cut", err);
    return fallback();
  }
}

import "dotenv/config";

// Deliberately NOT part of ../../env.ts's required() checks, matching the
// RentVault KYC pattern: script generation is one feature of one route, and a
// missing model key should degrade that feature — not stop the API or the
// renderer from booting.
//
// When the key is unset, generateScript() returns the deterministic template in
// fallback.ts and marks the creative `scriptSource: "fallback"`. The wizard
// still works end to end; the copy is just formulaic rather than written for
// the business.
export const scriptEnv = {
  apiKey: process.env.ANTHROPIC_API_KEY,
  // Claude Opus 5. Overridable so a cost-sensitive deployment can drop to
  // Sonnet without a code change.
  model: process.env.ANTHROPIC_MODEL ?? "claude-opus-5",
};

export function isScriptGenerationConfigured(): boolean {
  return Boolean(scriptEnv.apiKey);
}

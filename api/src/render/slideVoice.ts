// The voice-over for the "This month's offer" slide (render/offerSlide.ts,
// owner decision 2026-11-22). The SAME voice path as the ads: the configured
// provider through synthesizeVoice (fal ElevenLabs when VOICE_PROVIDER=fal +
// FAL_KEY, else edge-tts), a failed paid call falling back to edge-tts, and a
// paid result cached in R2 under the ads' key scheme (provider | voice | text),
// so both shapes of one change share ONE TTS call (~2-3 cents).
//
// Both shapes of a change are separate render jobs. With RENDER_CONCURRENCY=1
// (the default) they run one after the other and the second reads the cache.
// With more slots they could run at once, so a paid synthesis is also shared
// in-process while it is in flight (singleFlight). Two renderer REPLICAS could
// still both pay once each (a few cents); nothing here can prevent that.
//
// Kept free of R2 / vendor imports (everything comes in as deps) so it is
// testable with a stubbed TTS.
import { createHash } from "node:crypto";

/** R2 key of a cached paid voice; the ads (render/worker.ts) use the same key. */
export function voiceCacheKey(campaignId: string, text: string, voice: string, provider = process.env.VOICE_PROVIDER ?? ""): string {
  const h = createHash("sha256").update(`${provider}|${voice}|${text}`).digest("hex").slice(0, 32);
  return `campaigns/${campaignId}/voice/${h}.mp3`;
}

export type SlideVoiceDeps = {
  /** The configured provider's name (voiceProvider()?.name), null = none. */
  providerName: () => string | null;
  synthesize: (req: { text: string; currency: "INR" | "USD"; voice?: string }) => Promise<{
    audioBytes: Buffer;
    source: string;
    fellBack?: string;
  }>;
  cacheGet: (key: string) => Promise<Buffer | null>;
  cachePut: (key: string, bytes: Buffer) => Promise<void>;
  log?: (msg: string, data?: unknown) => void;
};

export type SlideVoiceResult =
  | { ok: true; bytes: Buffer; provider: string; reused: boolean; fellBack?: string }
  | { ok: false; error: string };

const inFlight = new Map<string, Promise<SlideVoiceResult>>();

/** Display name of a provider's output, for render_info. */
function sourceFor(providerName: string): string {
  return providerName === "fal" ? "fal-elevenlabs" : providerName;
}

/**
 * The slide's narration as audio, or why there is none. Never throws: a
 * voice failure leaves the slide silent, it never fails the change.
 */
export async function slideVoice(
  args: { campaignId: string; text: string; voice: string; currency: "INR" | "USD" },
  deps: SlideVoiceDeps,
): Promise<SlideVoiceResult> {
  const log = deps.log ?? (() => undefined);
  const providerName = deps.providerName();
  if (!providerName) return { ok: false, error: "no voice provider configured" };
  if (!args.text.trim()) return { ok: false, error: "nothing to read" };
  const paid = providerName !== "edge-tts";
  const key = voiceCacheKey(args.campaignId, args.text, args.voice);

  const work = async (): Promise<SlideVoiceResult> => {
    // Only paid voices are worth caching; edge-tts is free.
    if (paid) {
      try {
        const hit = await deps.cacheGet(key);
        if (hit) return { ok: true, bytes: hit, provider: sourceFor(providerName), reused: true };
      } catch (err) {
        log("slide voice cache read failed; synthesizing", { key, error: String(err) });
      }
    }
    try {
      const result = await deps.synthesize({ text: args.text, currency: args.currency, voice: args.voice });
      // A fallback (edge-tts) result is not cached, so the other shape tries
      // the paid voice again (same rule as the ads).
      if (paid && !result.fellBack) {
        await deps.cachePut(key, result.audioBytes).catch((err) => log("slide voice cache write failed", { key, error: String(err) }));
      }
      return {
        ok: true,
        bytes: result.audioBytes,
        provider: result.fellBack ? "edge-tts" : result.source,
        reused: false,
        ...(result.fellBack ? { fellBack: result.fellBack } : {}),
      };
    } catch (err) {
      return { ok: false, error: (err instanceof Error ? err.message : String(err)).slice(0, 300) };
    }
  };

  if (!paid) return work();
  const running = inFlight.get(key);
  if (running) {
    const shared = await running;
    return shared.ok ? { ...shared, reused: true } : shared;
  }
  const p = work().finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

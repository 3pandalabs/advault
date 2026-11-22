// The offer slide's voice-over (render/slideVoice.ts), with the TTS and the R2
// cache stubbed: one paid call per change, shared by both shapes.
import { describe, expect, it, vi } from "vitest";
import { slideVoice, voiceCacheKey, type SlideVoiceDeps } from "./slideVoice.js";

function deps(over: Partial<SlideVoiceDeps> = {}) {
  const store = new Map<string, Buffer>();
  const synthesize = vi.fn(async (req: { text: string }) => {
    await new Promise((r) => setTimeout(r, 10));
    return { audioBytes: Buffer.from(`audio:${req.text}`), source: "fal-elevenlabs" };
  });
  const d: SlideVoiceDeps = {
    providerName: () => "fal",
    synthesize,
    cacheGet: async (k) => store.get(k) ?? null,
    cachePut: async (k, b) => {
      store.set(k, b);
    },
    ...over,
  };
  return { d, store, synthesize: d.synthesize as typeof synthesize };
}

const args = { campaignId: "camp1", text: "This month's offer: $25 off. Until December 31st.", voice: "Sarah", currency: "USD" as const };

describe("voiceCacheKey", () => {
  it("same provider + voice + text = same key; any change = a new key", () => {
    const k = voiceCacheKey("c", "hello", "Sarah", "fal");
    expect(k).toMatch(/^campaigns\/c\/voice\/[0-9a-f]{32}\.mp3$/);
    expect(voiceCacheKey("c", "hello", "Sarah", "fal")).toBe(k);
    expect(voiceCacheKey("c", "hello!", "Sarah", "fal")).not.toBe(k);
    expect(voiceCacheKey("c", "hello", "Roger", "fal")).not.toBe(k);
    expect(voiceCacheKey("c", "hello", "Sarah", "edge-tts")).not.toBe(k);
  });
});

describe("slideVoice", () => {
  it("one paid call; the other shape reads the R2 cache", async () => {
    const { d, synthesize, store } = deps();
    const a = await slideVoice(args, d);
    const b = await slideVoice(args, d);
    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(synthesize).toHaveBeenCalledWith({ text: args.text, currency: "USD", voice: "Sarah" });
    expect(a).toMatchObject({ ok: true, provider: "fal-elevenlabs", reused: false });
    expect(b).toMatchObject({ ok: true, provider: "fal-elevenlabs", reused: true });
    expect(store.size).toBe(1);
  });

  it("both shapes rendered at once still pay once (in-flight sharing)", async () => {
    const { d, synthesize } = deps();
    const [a, b] = await Promise.all([slideVoice(args, d), slideVoice(args, d)]);
    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(a.ok && b.ok).toBe(true);
    expect([a, b].filter((r) => r.ok && r.reused)).toHaveLength(1);
  });

  it("a paid failure that fell back to edge-tts is used but not cached", async () => {
    const { d, store } = deps({
      synthesize: async () => ({ audioBytes: Buffer.from("edge"), source: "edge-tts", fellBack: "fal voice failed" }),
    });
    const r = await slideVoice(args, d);
    expect(r).toMatchObject({ ok: true, provider: "edge-tts", fellBack: "fal voice failed" });
    expect(store.size).toBe(0);
  });

  it("edge-tts as the provider: free, never cached", async () => {
    const { d, synthesize, store } = deps({ providerName: () => "edge-tts", synthesize: vi.fn(async () => ({ audioBytes: Buffer.from("e"), source: "edge-tts" })) });
    await slideVoice(args, d);
    await slideVoice(args, d);
    expect(synthesize).toHaveBeenCalledTimes(2);
    expect(store.size).toBe(0);
  });

  it("both providers failing, or none configured, is a reason, never a throw", async () => {
    const failing = deps({
      synthesize: async () => {
        throw new Error("edge-tts exited 1");
      },
    });
    expect(await slideVoice(args, failing.d)).toEqual({ ok: false, error: "edge-tts exited 1" });
    expect(await slideVoice(args, deps({ providerName: () => null }).d)).toEqual({ ok: false, error: "no voice provider configured" });
    expect(await slideVoice({ ...args, text: "  " }, deps().d)).toEqual({ ok: false, error: "nothing to read" });
  });

  it("a cache read error still synthesizes; a cache write error is not fatal", async () => {
    const { d, synthesize } = deps({
      cacheGet: async () => {
        throw new Error("r2 down");
      },
      cachePut: async () => {
        throw new Error("r2 down");
      },
    });
    expect(await slideVoice(args, d)).toMatchObject({ ok: true, reused: false });
    expect(synthesize).toHaveBeenCalledTimes(1);
  });
});

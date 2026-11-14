import "dotenv/config";
import { execFile } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

const exec = promisify(execFile);

// Voiceover. Two providers, and the default one is free.
//
// edge-tts drives Microsoft Edge's online TTS voices. It needs no account, no
// API key and no per-use cost — which is why it is the default rather than
// ElevenLabs. For a 15-second local ad read, the quality difference does not
// justify introducing a metered vendor into the render path, and a free default
// means voiceover works on day one for every advertiser instead of being a
// feature gated behind a billing decision.
//
// Like motion clips, this is optional: no provider means a silent cut, which is
// exactly what the renderer already produces today.
//
// 2026-11-13: the paid default is ElevenLabs v3 through fal (VOICE_PROVIDER=fal,
// FAL_KEY), the voice the home-page demos use; edge-tts sounded robotic next
// to them. A failed fal call falls back to edge-tts (synthesizeVoice), never
// to silence. Scripts start with an ElevenLabs audio tag ("[warmly] ..."),
// which edge-tts would read aloud, so it is stripped for edge-tts.

export type VoiceRequest = {
  text: string;
  /** Language/market, so the Indian market gets an Indian English voice. */
  currency: "INR" | "USD";
};

export type VoiceResult = { audioBytes: Buffer; source: "edge-tts" | "elevenlabs" | "fal-elevenlabs" };

export interface VoiceProvider {
  readonly name: "edge-tts" | "elevenlabs" | "fal";
  isConfigured(): boolean;
  synthesize(req: VoiceRequest): Promise<VoiceResult>;
}

// --- edge-tts (free, no account) -------------------------------------------

// Neural voices. en-IN for the Indian market so a Delhi plumber's ad does not
// open in a US accent — a small thing that reads as "not from here", which is
// the opposite of the product's whole pitch.
const EDGE_VOICES: Record<"INR" | "USD", string> = {
  INR: process.env.EDGE_TTS_VOICE_IN ?? "en-IN-PrabhatNeural",
  USD: process.env.EDGE_TTS_VOICE_US ?? "en-US-GuyNeural",
};

export const edgeTts: VoiceProvider = {
  name: "edge-tts",

  // Present in the renderer image (see Dockerfile.renderer). The API container
  // has no need for it — voiceover is generated during the render, not the
  // request.
  isConfigured: () => process.env.DISABLE_EDGE_TTS !== "1",

  async synthesize(req) {
    const out = join(tmpdir(), `advault-tts-${randomUUID()}.mp3`);
    try {
      // execFile with an argument ARRAY, never a shell string. The text here
      // originates from a model and, upstream of that, from advertiser-supplied
      // input — interpolating it into a shell command would be command
      // injection. Same rule as the ffmpeg calls in render/ffmpeg.ts.
      await exec(
        "edge-tts",
        ["--voice", EDGE_VOICES[req.currency], "--text", stripAudioTags(req.text), "--write-media", out],
        { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
      );
      return { audioBytes: await readFile(out), source: "edge-tts" };
    } finally {
      await unlink(out).catch(() => undefined);
    }
  },
};

// --- ElevenLabs (paid, optional upgrade) -----------------------------------

const ELEVEN_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVEN_VOICE = process.env.ELEVENLABS_VOICE_ID ?? "21m00Tcm4TlvDq8ikWAM";

export const elevenLabs: VoiceProvider = {
  name: "elevenlabs",
  isConfigured: () => Boolean(ELEVEN_KEY),

  async synthesize(req) {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE}`, {
      method: "POST",
      headers: { "xi-api-key": ELEVEN_KEY!, "content-type": "application/json" },
      body: JSON.stringify({
        text: req.text,
        model_id: "eleven_turbo_v2_5",
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    });
    if (!res.ok) throw new Error(`ElevenLabs failed: ${res.status}`);
    return { audioBytes: Buffer.from(await res.arrayBuffer()), source: "elevenlabs" };
  },
};

// --- ElevenLabs v3 through fal (paid, the demo voice) -----------------------

/** "[warmly] Hello" -> "Hello": audio tags are for ElevenLabs v3 only. */
export function stripAudioTags(text: string): string {
  return text.replace(/\[[a-z ]{2,30}\]\s*/gi, "").trim();
}

const FAL_ENDPOINT = "fal-ai/elevenlabs/tts/eleven-v3";
// ElevenLabs premade voices by name, as the demos use them.
const FAL_VOICE = process.env.FAL_VOICE ?? "Sarah";
const FAL_TIMEOUT_MS = 120_000;

export const falElevenLabs: VoiceProvider = {
  name: "fal",
  isConfigured: () => Boolean(process.env.FAL_KEY),

  async synthesize(req) {
    const headers = { authorization: `Key ${process.env.FAL_KEY}`, "content-type": "application/json" };
    const submit = await fetch(`https://queue.fal.run/${FAL_ENDPOINT}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: req.text, voice: FAL_VOICE, stability: 0.5 }),
      signal: AbortSignal.timeout(30_000),
    });
    const job = (await submit.json()) as { status_url?: string; response_url?: string };
    if (!submit.ok || !job.status_url || !job.response_url) throw new Error(`fal submit failed: ${submit.status}`);

    const started = Date.now();
    for (;;) {
      await new Promise((r) => setTimeout(r, 1500));
      const st = (await (await fetch(job.status_url, { headers, signal: AbortSignal.timeout(15_000) })).json()) as {
        status?: string;
        error?: unknown;
      };
      if (st.status === "COMPLETED") break;
      if (st.status === "FAILED" || st.error) throw new Error("fal voice failed");
      if (Date.now() - started > FAL_TIMEOUT_MS) throw new Error("fal voice timed out");
    }
    const out = (await (await fetch(job.response_url, { headers, signal: AbortSignal.timeout(15_000) })).json()) as {
      audio?: { url?: string };
      audio_url?: string;
      url?: string;
    };
    const url = out.audio?.url ?? out.audio_url ?? out.url;
    if (!url) throw new Error("fal voice returned no audio");
    const audio = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!audio.ok) throw new Error(`fal audio download failed: ${audio.status}`);
    return { audioBytes: Buffer.from(await audio.arrayBuffer()), source: "fal-elevenlabs" };
  },
};

/** Configured provider, or null for a silent cut. ElevenLabs wins if both exist. */
export function voiceProvider(): VoiceProvider | null {
  const preferred = process.env.VOICE_PROVIDER;
  if (preferred === "fal") return falElevenLabs.isConfigured() ? falElevenLabs : edgeTts.isConfigured() ? edgeTts : null;
  if (preferred === "elevenlabs") return elevenLabs.isConfigured() ? elevenLabs : null;
  if (preferred === "edge-tts") return edgeTts.isConfigured() ? edgeTts : null;
  if (elevenLabs.isConfigured()) return elevenLabs;
  if (edgeTts.isConfigured()) return edgeTts;
  return null;
}

/**
 * The configured provider, and if it is a paid one that fails, edge-tts: a
 * vendor outage costs voice quality, never the voiceover.
 */
export async function synthesizeVoice(req: VoiceRequest): Promise<VoiceResult & { fellBack?: string }> {
  const provider = voiceProvider();
  if (!provider) throw new Error("no voice provider");
  try {
    return await provider.synthesize(req);
  } catch (err) {
    if (provider === edgeTts || !edgeTts.isConfigured()) throw err;
    const res = await edgeTts.synthesize(req);
    return { ...res, fellBack: err instanceof Error ? err.message : String(err) };
  }
}

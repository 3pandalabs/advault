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

export type VoiceRequest = {
  text: string;
  /** Language/market, so the Indian market gets an Indian English voice. */
  currency: "INR" | "USD";
};

export type VoiceResult = { audioBytes: Buffer; source: "edge-tts" | "elevenlabs" };

export interface VoiceProvider {
  readonly name: "edge-tts" | "elevenlabs";
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
        ["--voice", EDGE_VOICES[req.currency], "--text", req.text, "--write-media", out],
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

/** Configured provider, or null for a silent cut. ElevenLabs wins if both exist. */
export function voiceProvider(): VoiceProvider | null {
  const preferred = process.env.VOICE_PROVIDER;
  if (preferred === "elevenlabs") return elevenLabs.isConfigured() ? elevenLabs : null;
  if (preferred === "edge-tts") return edgeTts.isConfigured() ? edgeTts : null;
  if (elevenLabs.isConfigured()) return elevenLabs;
  if (edgeTts.isConfigured()) return edgeTts;
  return null;
}

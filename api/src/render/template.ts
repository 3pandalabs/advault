import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { AdScript } from "../lib/script/schema.js";
import type { AspectRatio } from "./ffmpeg.js";
import { DIMENSIONS } from "./ffmpeg.js";

const exec = promisify(execFile);

// The template ad (2026-11-13): the look of the home-page demos, rendered by
// Remotion in api/remotion (Chrome headless, own package, installed only in
// the renderer image). On when RENDER_ENGINE=template. Any failure returns
// null and the worker renders the ffmpeg layout instead, so the template can
// never cost a customer their ad.

export const TEMPLATE_ENABLED = process.env.RENDER_ENGINE === "template";
const RENDER_SCRIPT = process.env.TEMPLATE_RENDER_SCRIPT ?? resolve("remotion/render.mjs");
const TIMEOUT_MS = Number(process.env.TEMPLATE_TIMEOUT_MS ?? 8 * 60_000);

// Brand + accent per category, from the demos (accent is the sticker yellow).
// Unknown categories get a stable pick from the list by name.
const PALETTES: Record<string, string> = {
  salon: "#8c1f5b",
  barber: "#1f2a44",
  beauty: "#8c1f5b",
  spa: "#0f5e7a",
  dentist: "#0f5e7a",
  dental: "#0f5e7a",
  clinic: "#0f5e7a",
  doctor: "#0f5e7a",
  "real estate": "#1d3d2f",
  realtor: "#1d3d2f",
  bakery: "#7a3e1d",
  cafe: "#7a3e1d",
  coffee: "#7a3e1d",
  restaurant: "#7a1d1d",
  plumber: "#1f4e8c",
  plumbing: "#1f4e8c",
  hvac: "#1f4e8c",
  electrician: "#1f4e8c",
  auto: "#2b2b2b",
  fitness: "#5b2be0",
  gym: "#5b2be0",
};
const FALLBACK_BRANDS = ["#5b2be0", "#1f4e8c", "#0f5e7a", "#1d3d2f", "#7a3e1d", "#8c1f5b"];
const ACCENT = "#ffc94a";

export function brandColorFor(category: string): string {
  const c = category.toLowerCase();
  for (const [k, v] of Object.entries(PALETTES)) if (c.includes(k)) return v;
  let h = 0;
  for (const ch of c) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return FALLBACK_BRANDS[h % FALLBACK_BRANDS.length];
}

/** "https://www.bellahair.com/book?x" -> "bellahair.com". */
export function displayDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * Scene captions as the on-screen phrases, spread over the voiceover in
 * proportion to their word counts (the voice reads roughly at an even pace).
 */
export function timeCaptions(captions: string[], spokenSeconds: number): { text: string; from: number; to: number }[] {
  const words = captions.map((c) => Math.max(1, c.split(/\s+/).filter(Boolean).length));
  const total = words.reduce((a, b) => a + b, 0);
  const span = Math.max(spokenSeconds - 0.2, 1);
  let t = 0.1;
  return captions.map((text, i) => {
    const d = (span * words[i]) / total;
    const cue = { text, from: Math.round(t * 100) / 100, to: Math.round((t + d) * 100) / 100 };
    t += d;
    return cue;
  });
}

async function audioSeconds(path: string): Promise<number | null> {
  try {
    const { stdout } = await exec("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path], {
      timeout: 15_000,
    });
    const n = Number(stdout.trim());
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export type TemplateInputs = {
  workDir: string;
  script: AdScript;
  aspectRatio: AspectRatio;
  imagePaths: string[];
  clipPaths: Map<number, string>;
  voicePath?: string;
  businessName: string;
  businessCategory: string;
  landingUrl: string;
};

/** Renders the template ad; returns the MP4 path, or null to fall back. */
export async function renderTemplate(input: TemplateInputs, log: (msg: string, extra?: unknown) => void): Promise<{
  videoPath: string;
  durationSeconds: number;
} | null> {
  const { script } = input;
  const sticker = script.sticker ?? {
    badge: "LOCAL",
    headline: input.businessCategory.toUpperCase().slice(0, 24),
    tagline: "NEAR YOU",
    benefits: [],
  };

  // One visual per scene, in script order: its motion clip if one was made,
  // else its photo. Paths are relative to workDir (render.mjs serves it).
  const photos = script.scenes.map((s, i) => {
    const clip = input.clipPaths.get(i);
    if (clip) return basename(clip);
    const img = input.imagePaths[Math.min(s.assetIndex, input.imagePaths.length - 1)];
    return basename(img);
  });

  const spoken = input.voicePath ? await audioSeconds(input.voicePath) : null;
  const sceneSeconds = script.scenes.reduce((a, s) => a + s.durationSeconds, 0);
  // Room for the voice plus the 4.2 s end card; within YouTube-friendly bounds.
  const durationSeconds = Math.min(20, Math.max(12, Math.ceil((spoken ?? sceneSeconds - 2) + 5)));
  const captions = timeCaptions(
    script.scenes.map((s) => s.caption),
    spoken ?? durationSeconds - 4.5,
  );

  const { width, height } = DIMENSIONS[input.aspectRatio];
  const props = {
    shopName: input.businessName,
    area: "",
    priceText: sticker.badge,
    itemText: sticker.headline,
    validText: sticker.tagline,
    benefits: sticker.benefits,
    ctaLabel: script.callToAction,
    website: displayDomain(input.landingUrl),
    brandColor: brandColorFor(input.businessCategory),
    accentColor: ACCENT,
    photos,
    voiceover: input.voicePath ? basename(input.voicePath) : undefined,
    captions,
    durationSeconds,
    width,
    height,
  };
  await writeFile(join(input.workDir, "props.json"), JSON.stringify(props), "utf8");

  const out = join(input.workDir, "template.mp4");
  const started = Date.now();
  try {
    // cwd = the template package: Remotion finds its downloaded Chrome under
    // <cwd>/node_modules/.remotion, and /app/node_modules is not writable.
    await exec("node", [RENDER_SCRIPT, input.workDir, out], {
      cwd: dirname(RENDER_SCRIPT),
      timeout: TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
    log("template render complete", { seconds: Math.round((Date.now() - started) / 1000), durationSeconds });
    return { videoPath: out, durationSeconds };
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    log("template render failed; falling back to the ffmpeg layout", {
      error: (e.stderr || e.message || String(err)).slice(-800),
    });
    return null;
  }
}

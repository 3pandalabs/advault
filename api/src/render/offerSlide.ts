// "Change my offer" for an uploaded-video ad (lib/offerSwap, 2026-11-22):
// the owner's video, untouched, followed by ONE ~4 s end slide:
//
//   This month's offer          (amber)
//   ───                         (amber accent bar)
//   $25 off any move-out clean  (white, bold, wrapped to fit the shape)
//   Until Dec 31                (zinc)
//
// ffmpeg only: no AI, no vendor, $0 (same rule as render/reformat.ts). Both
// segments are normalised to the SOURCE's size, frame rate, SAR 1, yuv420p and
// 48 kHz stereo before the concat filter joins them, so concat never sees
// mismatched streams. The video part keeps its own audio (padded/trimmed to
// the video length); the slide is silent.
//
// Text goes in through drawtext `textfile=` files written next to the job, and
// the fonts are copied in beside them, with ffmpeg run IN that directory: the
// filter graph only ever names plain relative files (slide-0.txt, bold.ttf), so
// nothing the owner typed is ever parsed as filter syntax, and no path needs
// escaping (a Windows "C:" in a fontfile would). Argument array, never a shell.

import { execFile } from "node:child_process";
import { copyFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export const SLIDE_BG = "0x09090b"; // zinc-950, the app's background
const ACCENT = "0xF59E0B"; // amber-500
const HEADING_COLOR = "0xFBBF24"; // amber-400
const UNTIL_COLOR = "0xD4D4D8"; // zinc-300

// ---------------------------------------------------------------------------
// Probe (pure parse of `ffprobe -print_format json -show_streams -show_format`).
// ---------------------------------------------------------------------------

export type SourceProbe = {
  width: number;
  height: number;
  /** As a rational ffmpeg accepts ("30", "30000/1001"). */
  fps: string;
  hasAudio: boolean;
  /** Seconds of the video stream (format duration as a fallback). */
  durationSeconds: number;
};

function rate(r: unknown): number {
  if (typeof r !== "string") return 0;
  const [n, d] = r.split("/").map(Number);
  if (!Number.isFinite(n)) return 0;
  return d ? n! / d : n!;
}

/** Even dimensions (yuv420p needs them), a sane frame rate, the real length. */
export function parseProbe(json: unknown): SourceProbe {
  const j = json as { streams?: Record<string, unknown>[]; format?: { duration?: string } };
  const v = j.streams?.find((s) => s.codec_type === "video");
  if (!v) throw new Error("source has no video stream");
  const even = (x: unknown) => Math.max(2, Math.floor(Number(x) / 2) * 2);
  const width = even(v.width);
  const height = even(v.height);
  if (!Number.isFinite(width) || !Number.isFinite(height)) throw new Error("source has no frame size");
  let fps = typeof v.r_frame_rate === "string" ? v.r_frame_rate : "30";
  const fpsN = rate(fps);
  if (!(fpsN >= 15 && fpsN <= 60)) {
    const avg = rate(v.avg_frame_rate);
    fps = avg >= 15 && avg <= 60 ? String(v.avg_frame_rate) : "30";
  }
  const duration = Number(v.duration ?? j.format?.duration);
  if (!(duration > 0)) throw new Error("source has no duration");
  return {
    width,
    height,
    fps,
    hasAudio: Boolean(j.streams?.some((s) => s.codec_type === "audio")),
    durationSeconds: duration,
  };
}

// ---------------------------------------------------------------------------
// Layout (pure).
// ---------------------------------------------------------------------------

/** Word wrap to `maxChars` a line; a word longer than a line is split. */
export function wrapText(text: string, maxChars: number): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (let w of words) {
    while (w.length > maxChars) {
      if (line) {
        lines.push(line);
        line = "";
      }
      lines.push(w.slice(0, maxChars));
      w = w.slice(maxChars);
    }
    if (!w) continue;
    if (!line) line = w;
    else if (line.length + 1 + w.length <= maxChars) line += ` ${w}`;
    else {
      lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export type SlideText = { text: string; font: "bold" | "regular"; size: number; color: string; y: number };
export type SlideLayout = { texts: SlideText[]; bar: { x: number; y: number; w: number; h: number } };

/**
 * Conservative width of one character as a share of the font size (DejaVu
 * Sans Bold averages under 0.62 em; capitals and digits run wider), so a line
 * never reaches the margins.
 */
const CHAR_EM = 0.66;
const MAX_OFFER_LINES = 8;
const LINE = 1.25;

export function slideLayout(args: { width: number; height: number; heading: string; offer: string; until: string }): SlideLayout {
  const { width: W, height: H } = args;
  const S = Math.min(W, H);
  // 8% side margins; the offer block may use 55% of the height.
  const safeW = W * 0.84;
  const headingSize = Math.round(S * 0.056);
  const untilSize = Math.round(S * 0.05);
  const maxSize = Math.round(S * 0.083);
  const minSize = Math.round(S * 0.033);
  const cpl = (size: number) => Math.max(4, Math.floor(safeW / (size * CHAR_EM)));

  let size = maxSize;
  let lines = wrapText(args.offer, cpl(size));
  while (size > minSize && (lines.length > MAX_OFFER_LINES || lines.length * size * LINE > H * 0.55)) {
    size -= 2;
    lines = wrapText(args.offer, cpl(size));
  }
  const fitLines = Math.max(1, Math.min(MAX_OFFER_LINES, Math.floor((H * 0.55) / (size * LINE))));
  if (lines.length > fitLines) {
    lines = lines.slice(0, fitLines);
    const last = lines[fitLines - 1]!;
    lines[fitLines - 1] = `${last.slice(0, Math.max(1, cpl(size) - 1)).replace(/\s+$/, "")}…`;
  }

  const gap = Math.round(S * 0.04);
  const barH = Math.max(4, Math.round(S * 0.008));
  const offerH = Math.round(lines.length * size * LINE);
  const total = headingSize + gap + barH + gap + offerH + (args.until ? gap + untilSize : 0);
  let y = Math.round((H - total) / 2);

  const texts: SlideText[] = [{ text: args.heading, font: "bold", size: headingSize, color: HEADING_COLOR, y }];
  y += headingSize + gap;
  const barW = Math.round(W * 0.12);
  const bar = { x: Math.round((W - barW) / 2), y, w: barW, h: barH };
  y += barH + gap;
  for (const l of lines) {
    texts.push({ text: l, font: "bold", size, color: "white", y: Math.round(y + (size * LINE - size) / 2) });
    y += size * LINE;
  }
  if (args.until) texts.push({ text: args.until, font: "regular", size: untilSize, color: UNTIL_COLOR, y: Math.round(y + gap) });
  return { texts, bar };
}

// ---------------------------------------------------------------------------
// The ffmpeg command (pure).
// ---------------------------------------------------------------------------

export const SLIDE_FONT_FILES = { bold: "bold.ttf", regular: "regular.ttf" } as const;

export type SlideCommand = {
  /** Files to write in the job directory before running (name -> contents). */
  textFiles: { name: string; text: string }[];
  /** ffmpeg arguments (after `-y -hide_banner -loglevel error`), run with cwd = the job directory. */
  args: string[];
};

export function offerSlideCommand(args: {
  inputPath: string;
  outputPath: string;
  probe: SourceProbe;
  layout: SlideLayout;
  slideSeconds: number;
}): SlideCommand {
  const { width: W, height: H, fps, hasAudio, durationSeconds } = args.probe;
  const vd = durationSeconds.toFixed(3);
  const sd = args.slideSeconds.toFixed(3);
  const textFiles = args.layout.texts.map((t, i) => ({ name: `slide-${i}.txt`, text: t.text }));
  const draws = args.layout.texts.map(
    (t, i) =>
      `drawtext=fontfile=${SLIDE_FONT_FILES[t.font]}:textfile=slide-${i}.txt:expansion=none` +
      `:fontcolor=${t.color}:fontsize=${t.size}:x=(w-text_w)/2:y=${t.y}`,
  );
  const { bar } = args.layout;
  const graph = [
    // The owner's video, unchanged apart from normalising (a no-op scale for
    // their own size; any odd pixel is padded with the slide colour).
    `[0:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=${SLIDE_BG},` +
      `setsar=1,fps=${fps},format=yuv420p,trim=duration=${vd},setpts=PTS-STARTPTS[v0]`,
    hasAudio
      ? `[0:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=duration=${vd},asetpts=PTS-STARTPTS[a0]`
      : `anullsrc=r=48000:cl=stereo,atrim=duration=${vd}[a0]`,
    [
      `color=c=${SLIDE_BG}:s=${W}x${H}:r=${fps}:d=${sd}`,
      `drawbox=x=${bar.x}:y=${bar.y}:w=${bar.w}:h=${bar.h}:color=${ACCENT}:t=fill`,
      ...draws,
      `fade=t=in:st=0:d=0.3:color=${SLIDE_BG}`,
      `setsar=1`,
      `format=yuv420p[v1]`,
    ].join(","),
    `anullsrc=r=48000:cl=stereo,atrim=duration=${sd}[a1]`,
    `[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]`,
  ].join(";");
  return {
    textFiles,
    args: [
      "-i", args.inputPath,
      "-filter_complex", graph,
      "-map", "[v]", "-map", "[a]",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-threads", "2",
      "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2",
      "-movflags", "+faststart",
      args.outputPath,
    ],
  };
}

// ---------------------------------------------------------------------------
// IO.
// ---------------------------------------------------------------------------

async function run(bin: "ffmpeg" | "ffprobe", args: string[], cwd?: string): Promise<string> {
  try {
    const { stdout } = await exec(bin, args, { maxBuffer: 8 * 1024 * 1024, cwd });
    return stdout;
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr;
    throw new Error(`${bin} failed: ${stderr?.slice(0, 500) ?? String(err)}`);
  }
}

export async function probeSource(path: string): Promise<SourceProbe> {
  const out = await run("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", path]);
  return parseProbe(JSON.parse(out));
}

export async function renderOfferSlide(args: {
  inputPath: string;
  workDir: string;
  heading: string;
  offer: string;
  until: string;
  slideSeconds: number;
  fonts: { bold: string; regular: string };
}): Promise<{ videoPath: string; thumbnailPath: string; durationSeconds: number }> {
  const probe = await probeSource(args.inputPath);
  const layout = slideLayout({ width: probe.width, height: probe.height, heading: args.heading, offer: args.offer, until: args.until });
  const videoPath = join(args.workDir, "offer-slide.mp4");
  const thumbnailPath = join(args.workDir, "offer-slide.jpg");
  const cmd = offerSlideCommand({ inputPath: args.inputPath, outputPath: videoPath, probe, layout, slideSeconds: args.slideSeconds });
  await copyFile(args.fonts.bold, join(args.workDir, SLIDE_FONT_FILES.bold));
  await copyFile(args.fonts.regular, join(args.workDir, SLIDE_FONT_FILES.regular));
  for (const f of cmd.textFiles) await writeFile(join(args.workDir, f.name), f.text, "utf8");
  await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...cmd.args], args.workDir);
  const at = Math.min(1, probe.durationSeconds / 2).toFixed(2);
  await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-ss", at, "-i", videoPath, "-frames:v", "1", "-q:v", "3", thumbnailPath]);
  return { videoPath, thumbnailPath, durationSeconds: probe.durationSeconds + args.slideSeconds };
}

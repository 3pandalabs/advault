import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AdScript } from "../lib/script/schema.js";

const exec = promisify(execFile);

// Output geometry. 1080p-class on both axes — what YouTube and Shorts ingest
// without re-encoding twice, and small enough that a 15-second spot lands
// around 3–5 MB.
export const DIMENSIONS = {
  "16:9": { width: 1920, height: 1080 },
  "9:16": { width: 1080, height: 1920 },
} as const;

export type AspectRatio = keyof typeof DIMENSIONS;

// Every ffmpeg invocation goes through execFile with an argument ARRAY — never
// a shell string. Captions come from a model and, upstream of that, from
// advertiser-supplied text; interpolating either into a shell command is
// command injection with extra steps. execFile does not spawn a shell, so
// argument values can never be parsed as syntax.
async function ffmpeg(args: string[]): Promise<void> {
  try {
    // maxBuffer raised because ffmpeg is chatty on stderr and the default 1MB
    // truncates the very output needed to diagnose a failed encode.
    await exec("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args], {
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr;
    throw new Error(`ffmpeg failed: ${stderr?.slice(0, 500) ?? String(err)}`);
  }
}

// drawtext takes its value through a colon-and-comma-delimited filter string,
// so a caption containing any of these characters would either break the filter
// or change its meaning. Escaped rather than stripped — an apostrophe in
// "Mike's Plumbing" should render, not vanish.
function escapeDrawText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/%/g, "\\%")
    .replace(/,/g, "\\,")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");
}

// One scene: a still photo with a slow zoom (the Ken Burns effect) and a
// caption bar across the lower third.
//
// The scale-then-crop pair before zoompan is not optional. zoompan operates on
// whatever it is handed, so feeding it a portrait photo for a 16:9 render
// produces pillarboxed output with the subject off-centre; scaling to cover and
// cropping to the exact frame first means every source aspect ratio lands the
// same way.
async function renderScene(args: {
  imagePath: string;
  outputPath: string;
  caption: string;
  durationSeconds: number;
  aspectRatio: AspectRatio;
}): Promise<void> {
  const { width, height } = DIMENSIONS[args.aspectRatio];
  const fps = 30;
  const frames = Math.round(args.durationSeconds * fps);
  const fontSize = args.aspectRatio === "9:16" ? 56 : 64;

  const filters = [
    `scale=${width}:${height}:force_original_aspect_ratio=increase`,
    `crop=${width}:${height}`,
    // Zoom to 1.08x across the scene. Subtle on purpose — a still photo that
    // visibly lurches reads as cheap, which is the opposite of the point.
    `zoompan=z='min(zoom+0.0006,1.08)':d=${frames}:s=${width}x${height}:fps=${fps}`,
    // Scrim behind the caption so light text stays legible over a bright
    // storefront photo. Without it, captions disappear on roughly half of the
    // photos small businesses actually upload.
    `drawbox=x=0:y=ih*0.72:w=iw:h=ih*0.18:color=black@0.55:t=fill`,
    [
      `drawtext=text='${escapeDrawText(args.caption)}'`,
      `fontcolor=white`,
      `fontsize=${fontSize}`,
      `x=(w-text_w)/2`,
      `y=h*0.78`,
      `line_spacing=8`,
      `box=0`,
    ].join(":"),
    `format=yuv420p`,
  ].join(",");

  await ffmpeg([
    "-loop", "1",
    "-i", args.imagePath,
    "-t", String(args.durationSeconds),
    "-vf", filters,
    "-r", String(fps),
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "23",
    "-pix_fmt", "yuv420p",
    args.outputPath,
  ]);
}

// Closing frame: business name and call to action on a flat background. Built
// with lavfi rather than from an uploaded photo so it renders identically
// regardless of what the advertiser uploaded.
async function renderEndCard(args: {
  outputPath: string;
  endCardText: string;
  callToAction: string;
  aspectRatio: AspectRatio;
}): Promise<void> {
  const { width, height } = DIMENSIONS[args.aspectRatio];
  const durationSeconds = 2.5;

  const filters = [
    [
      `drawtext=text='${escapeDrawText(args.endCardText)}'`,
      `fontcolor=white`,
      `fontsize=${args.aspectRatio === "9:16" ? 72 : 84}`,
      `x=(w-text_w)/2`,
      `y=(h/2)-text_h`,
    ].join(":"),
    [
      `drawtext=text='${escapeDrawText(args.callToAction)}'`,
      `fontcolor=0xF5C242`,
      `fontsize=${args.aspectRatio === "9:16" ? 52 : 60}`,
      `x=(w-text_w)/2`,
      `y=(h/2)+text_h`,
    ].join(":"),
    "format=yuv420p",
  ].join(",");

  await ffmpeg([
    "-f", "lavfi",
    "-i", `color=c=0x101418:s=${width}x${height}:d=${durationSeconds}:r=30`,
    "-vf", filters,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "23",
    "-pix_fmt", "yuv420p",
    args.outputPath,
  ]);
}

// Concatenates the rendered segments. The demuxer form (-f concat) rather than
// the filter form: every segment was encoded here with identical parameters, so
// this is a stream copy — near-instant, and no generation loss from a second
// encode.
//
// `-safe 0` is required because the list holds absolute paths into the scratch
// directory. That flag exists to stop a concat list from referencing arbitrary
// files, which matters when the list is untrusted — here it is written by this
// function from paths this function generated, so nothing external influences
// it.
async function concatSegments(listFilePath: string, outputPath: string): Promise<void> {
  await ffmpeg([
    "-f", "concat",
    "-safe", "0",
    "-i", listFilePath,
    "-c", "copy",
    "-movflags", "+faststart",
    outputPath,
  ]);
}

async function extractThumbnail(videoPath: string, outputPath: string): Promise<void> {
  // One second in, not frame zero — the first frame of a zoompan segment is the
  // least interesting frame of the whole ad.
  await ffmpeg(["-ss", "1", "-i", videoPath, "-frames:v", "1", "-q:v", "3", outputPath]);
}

export type RenderInputs = {
  workDir: string;
  script: AdScript;
  aspectRatio: AspectRatio;
  // Local paths of the downloaded source photos, in the same order as the
  // creative's sourceAssetKeys — so script.scenes[].assetIndex indexes here.
  imagePaths: string[];
};

export type RenderOutputs = {
  videoPath: string;
  thumbnailPath: string;
  durationSeconds: number;
};

export async function renderCreative(input: RenderInputs): Promise<RenderOutputs> {
  const { join } = await import("node:path");
  const { writeFile } = await import("node:fs/promises");

  const segments: string[] = [];
  let durationSeconds = 0;

  for (const [i, scene] of input.script.scenes.entries()) {
    // Clamped again here rather than trusted: generate.ts already clamps, but
    // this module also runs against scripts an advertiser edited by hand, and
    // an out-of-range index would otherwise be an undefined path passed to
    // ffmpeg as a filename.
    const imagePath = input.imagePaths[Math.min(scene.assetIndex, input.imagePaths.length - 1)];
    if (!imagePath) throw new Error(`Scene ${i} has no source image`);

    const segmentPath = join(input.workDir, `scene-${i}.mp4`);
    await renderScene({
      imagePath,
      outputPath: segmentPath,
      caption: scene.caption,
      durationSeconds: scene.durationSeconds,
      aspectRatio: input.aspectRatio,
    });
    segments.push(segmentPath);
    durationSeconds += scene.durationSeconds;
  }

  const endCardPath = join(input.workDir, "end-card.mp4");
  await renderEndCard({
    outputPath: endCardPath,
    endCardText: input.script.endCardText,
    callToAction: input.script.callToAction,
    aspectRatio: input.aspectRatio,
  });
  segments.push(endCardPath);
  durationSeconds += 2.5;

  const listPath = join(input.workDir, "segments.txt");
  await writeFile(listPath, segments.map((p) => `file '${p}'`).join("\n"), "utf8");

  const videoPath = join(input.workDir, "output.mp4");
  await concatSegments(listPath, videoPath);

  const thumbnailPath = join(input.workDir, "thumbnail.jpg");
  await extractThumbnail(videoPath, thumbnailPath);

  return { videoPath, thumbnailPath, durationSeconds: Math.round(durationSeconds) };
}

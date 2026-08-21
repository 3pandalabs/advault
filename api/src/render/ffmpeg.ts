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

// Absolute font paths, not a family name.
//
// `drawtext` with `font=Sans` needs fontconfig to resolve the family, and on a
// container with no font packages that resolution fails at ENCODE time with
// "Cannot find a valid font for the family Sans" — after the queue has been
// claimed and the job has burned its retries. Pinning the file means
// Dockerfile.renderer's `test -f` catches a missing or relocated font at BUILD
// time instead, where it is one red deploy rather than every creative failing.
//
// Overridable for local development, where the fonts live somewhere else
// entirely (macOS, Debian and Alpine all differ).
const FONT_REGULAR =
  process.env.RENDER_FONT_REGULAR ?? "/usr/share/fonts/dejavu/DejaVuSans.ttf";
const FONT_BOLD =
  process.env.RENDER_FONT_BOLD ?? "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf";

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
  /**
   * An AI-generated motion clip standing in for the still. When present the
   * Ken Burns zoom is dropped — the clip already moves, and zooming a moving
   * shot looks like a mistake rather than an effect.
   */
  clipPath?: string;
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
    ...(args.clipPath
      ? [`fps=${fps}`]
      : [`zoompan=z='min(zoom+0.0006,1.08)':d=${frames}:s=${width}x${height}:fps=${fps}`]),
    // Scrim behind the caption so light text stays legible over a bright
    // storefront photo. Without it, captions disappear on roughly half of the
    // photos small businesses actually upload.
    `drawbox=x=0:y=ih*0.72:w=iw:h=ih*0.18:color=black@0.55:t=fill`,
    [
      `drawtext=fontfile=${FONT_REGULAR}`,
      // See escapeDrawText: escaping % is not enough on its own.
      `expansion=none`,
      `text='${escapeDrawText(args.caption)}'`,
      `fontcolor=white`,
      `fontsize=${fontSize}`,
      `x=(w-text_w)/2`,
      `y=h*0.78`,
      `line_spacing=8`,
      `box=0`,
    ].join(":"),
    `format=yuv420p`,
  ].join(",");

  // Input differs, everything downstream of it does not. A still is looped for
  // the scene's duration; a clip is *also* looped (`-stream_loop -1`) because
  // vendors cap a generation at 5s while a scene may run to 8. Looping shows a
  // seam, but the alternative is a segment shorter than the timeline says it
  // is, which desynchronises every caption after it and the voiceover with it.
  const input = args.clipPath
    ? ["-stream_loop", "-1", "-i", args.clipPath]
    : ["-loop", "1", "-i", args.imagePath];

  await ffmpeg([
    ...input,
    "-t", String(args.durationSeconds),
    "-vf", filters,
    "-r", String(fps),
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "23",
    "-pix_fmt", "yuv420p",
    // Segments must be video-only. The concat demuxer below stream-copies, and
    // that requires every segment to have an identical stream layout — a motion
    // clip that arrives with an audio track (vendor-dependent, and not
    // something to discover in production) would otherwise make the copy fail
    // or, worse, silently produce a file with audio on some scenes only.
    "-an",
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
      `drawtext=fontfile=${FONT_BOLD}`,
      `expansion=none`,
      `text='${escapeDrawText(args.endCardText)}'`,
      `fontcolor=white`,
      `fontsize=${args.aspectRatio === "9:16" ? 72 : 84}`,
      `x=(w-text_w)/2`,
      `y=(h/2)-text_h`,
    ].join(":"),
    [
      `drawtext=fontfile=${FONT_REGULAR}`,
      // See escapeDrawText: escaping % is not enough on its own.
      `expansion=none`,
      `text='${escapeDrawText(args.callToAction)}'`,
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
    "-an",
    args.outputPath,
  ]);
}

// Lays the voiceover over the finished cut.
//
// Done once at the end rather than per segment: the segments are stream-copied
// together, so giving them audio would mean every one of them needed an
// identically-encoded track, and a narration line would be chopped at every
// scene boundary. One mux over the concatenated video keeps the read continuous.
//
// `-af apad -shortest` together, and BOTH are required — this pair was got
// wrong once and the smoke test caught it.
//
// `-shortest` alone truncates the output to whichever input ends first, so a
// 4.6-second narration over a 13.5-second ad produced a 4.6-second ad: two
// thirds of the creative silently discarded, with a green render and a valid
// MP4 to show for it. `apad` pads the audio with silence indefinitely, which
// would otherwise never terminate; `-shortest` then cuts at the end of the
// video. The video is authoritative in both directions — a short voiceover is
// followed by silence, a long one is cut at the end card.
async function muxVoiceover(
  videoPath: string,
  voicePath: string,
  outputPath: string,
): Promise<void> {
  await ffmpeg([
    "-i", videoPath,
    "-i", voicePath,
    "-c:v", "copy",
    "-c:a", "aac",
    "-b:a", "128k",
    "-ac", "2",
    "-af", "apad",
    "-shortest",
    "-movflags", "+faststart",
    outputPath,
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
  // Optional AI motion clip per SCENE index (not per asset — two scenes may
  // share a photo and still get different motion). A hole in this map is not an
  // error: that scene falls back to the Ken Burns still, so a partial vendor
  // failure costs polish on one scene instead of the whole render.
  clipPaths?: Map<number, string>;
  // Optional voiceover audio for the whole spot. Absent means a silent cut.
  voicePath?: string;
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
      clipPath: input.clipPaths?.get(i),
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

  const silentPath = join(input.workDir, "output-silent.mp4");
  await concatSegments(listPath, silentPath);

  let videoPath = silentPath;
  if (input.voicePath) {
    videoPath = join(input.workDir, "output.mp4");
    await muxVoiceover(silentPath, input.voicePath, videoPath);
  }

  const thumbnailPath = join(input.workDir, "thumbnail.jpg");
  await extractThumbnail(videoPath, thumbnailPath);

  return { videoPath, thumbnailPath, durationSeconds: Math.round(durationSeconds) };
}

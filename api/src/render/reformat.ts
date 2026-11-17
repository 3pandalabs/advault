// Makes the other shape of an owner's uploaded video (lib/uploads/otherFormat):
// the video sharp and whole in the middle, over a blurred, darkened, enlarged
// copy of itself filling the frame. No AI, no vendor: ffmpeg only.

import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export function frameSize(aspect: "16:9" | "9:16"): { w: number; h: number } {
  return aspect === "16:9" ? { w: 1920, h: 1080 } : { w: 1080, h: 1920 };
}

/** The filter graph: blurred cover-fill background, the original contained on top. */
export function blurPadFilter(w: number, h: number): string {
  return (
    `[0:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},boxblur=28:4,eq=brightness=-0.08[bg];` +
    `[0:v]scale=${w}:${h}:force_original_aspect_ratio=decrease[fg];` +
    `[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1,format=yuv420p[v]`
  );
}

async function ffmpeg(args: string[]): Promise<void> {
  try {
    // Argument array, never a shell string (same rule as render/ffmpeg.ts).
    await exec("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args], { maxBuffer: 8 * 1024 * 1024 });
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr;
    throw new Error(`ffmpeg failed: ${stderr?.slice(0, 500) ?? String(err)}`);
  }
}

export async function reformatVideo(args: {
  inputPath: string;
  aspect: "16:9" | "9:16";
  workDir: string;
}): Promise<{ videoPath: string; thumbnailPath: string }> {
  const { w, h } = frameSize(args.aspect);
  const videoPath = join(args.workDir, "reformat.mp4");
  const thumbnailPath = join(args.workDir, "reformat.jpg");
  await ffmpeg([
    "-i", args.inputPath,
    "-filter_complex", blurPadFilter(w, h),
    "-map", "[v]", "-map", "0:a?",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-threads", "2",
    "-c:a", "aac", "-b:a", "160k",
    "-movflags", "+faststart",
    videoPath,
  ]);
  await ffmpeg(["-ss", "1", "-i", videoPath, "-frames:v", "1", "-q:v", "3", thumbnailPath]);
  return { videoPath, thumbnailPath };
}

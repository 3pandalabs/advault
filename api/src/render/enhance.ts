import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { getObjectBytes, headObject, presignDownload, putObject } from "../plugins/r2.js";
import { noteFalFailure } from "../lib/vendors/fal.js";

// "Pro photo" pass, the step that made the demo ads look polished
// (advault-creative-lab/stepH-us-demos.mjs): every customer photo goes through
// an image edit that brightens, sharpens and tidies it while keeping the same
// place, people and objects. fal `meta/muse-image/edit`, a few cents a photo.
//
// Optional and never load-bearing: off unless PHOTO_ENHANCE=fal and FAL_KEY is
// set, and any failure keeps the original photo. The agent's own portrait is
// never edited (their face must stay exactly theirs). Results are cached in R2
// per campaign and photo, so the other format and every redo reuse them.

const ENDPOINT = process.env.PHOTO_ENHANCE_ENDPOINT ?? "meta/muse-image/edit";
// Bump when the prompt changes, so cached edits are made again.
const PROMPT_VERSION = "v1";
export const ENHANCE_PROMPT =
  "Turn this into a professional advertising photo of the SAME place. Brighter, warm, even lighting; clean, natural colours; sharper; " +
  "tidy away loose clutter and rubbish. Keep the same room, layout, people, faces, clothes and objects exactly as they are. " +
  "Do not add any text, signs, logos or new objects.";
const TIMEOUT_MS = 150_000;

const run = promisify(execFile);

export function enhanceEnabled(): boolean {
  return process.env.PHOTO_ENHANCE === "fal" && Boolean(process.env.FAL_KEY);
}

/** "4:3"-style ratio of a local image, so the edit keeps the photo's shape. */
async function aspectOf(path: string): Promise<string | undefined> {
  try {
    const { stdout } = await run("ffprobe", [
      "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", path,
    ]);
    const [w, h] = stdout.trim().split("x").map(Number);
    if (!w || !h) return undefined;
    const r = w / h;
    if (r < 1 / 16 || r > 16) return undefined;
    return `${w}:${h}`;
  } catch {
    return undefined;
  }
}

async function falEdit(imageUrl: string, aspect: string | undefined): Promise<Buffer> {
  const headers = { authorization: `Key ${process.env.FAL_KEY}`, "content-type": "application/json" };
  const submit = await fetch(`https://queue.fal.run/${ENDPOINT}`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      prompt: ENHANCE_PROMPT,
      image_urls: [imageUrl],
      output_format: "jpeg",
      ...(aspect ? { aspect_ratio: aspect } : {}),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const job = (await submit.json().catch(() => ({}))) as { status_url?: string; response_url?: string };
  if (!submit.ok || !job.status_url || !job.response_url) {
    throw new Error(`fal enhance submit failed: ${submit.status} ${JSON.stringify(job).slice(0, 200)}`);
  }
  const started = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 3000));
    const st = (await (await fetch(job.status_url, { headers, signal: AbortSignal.timeout(15_000) })).json()) as {
      status?: string;
      error?: unknown;
    };
    if (st.status === "COMPLETED") break;
    if (st.status === "FAILED" || st.error) throw new Error(`fal enhance failed: ${JSON.stringify(st).slice(0, 200)}`);
    if (Date.now() - started > TIMEOUT_MS) throw new Error("fal enhance timed out");
  }
  const out = (await (await fetch(job.response_url, { headers, signal: AbortSignal.timeout(15_000) })).json()) as {
    images?: { url?: string }[];
  };
  const url = out.images?.[0]?.url;
  if (!url) throw new Error("fal enhance returned no image");
  const dl = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!dl.ok) throw new Error(`fal enhance download failed: ${dl.status}`);
  return Buffer.from(await dl.arrayBuffer());
}

export type EnhanceResult = {
  /** Local paths to render from (edited where it worked, else the original). */
  imagePaths: string[];
  /** R2 keys of the same images, for providers that fetch by URL (motion). */
  keys: string[];
  made: number;
  reused: number;
  errors: string[];
};

const IMAGE_EXT = /\.(jpe?g|png|webp)$/i;

export async function enhancePhotos(args: {
  campaignId: string;
  sourceAssetKeys: string[];
  imagePaths: string[];
  /** Indexes never to edit (the agent's portrait). */
  skip: number[];
  workDir: string;
  log: (msg: string, extra?: unknown) => void;
}): Promise<EnhanceResult> {
  const result: EnhanceResult = {
    imagePaths: [...args.imagePaths],
    keys: [...args.sourceAssetKeys],
    made: 0,
    reused: 0,
    errors: [],
  };
  if (!enhanceEnabled()) return result;

  await Promise.all(
    args.sourceAssetKeys.map(async (key, i) => {
      if (args.skip.includes(i) || !IMAGE_EXT.test(key)) return;
      const proKey = `campaigns/${args.campaignId}/pro/${createHash("sha256")
        .update(`${key}|${ENDPOINT}|${PROMPT_VERSION}`)
        .digest("hex")
        .slice(0, 32)}.jpg`;
      const proPath = join(args.workDir, `pro-${i}.jpg`);
      try {
        if (await headObject(proKey)) {
          await writeFile(proPath, await getObjectBytes(proKey));
          result.reused++;
        } else {
          const bytes = await falEdit(await presignDownload(key), await aspectOf(args.imagePaths[i]));
          await writeFile(proPath, bytes);
          await putObject(proKey, bytes, "image/jpeg").catch((err) =>
            args.log("pro photo cache write failed", { error: String(err) }),
          );
          result.made++;
        }
        result.imagePaths[i] = proPath;
        result.keys[i] = proKey;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result.errors.push(message.slice(0, 200));
        noteFalFailure("photo enhance", message);
        args.log("photo enhance failed; using the original", { index: i, error: message });
      }
    }),
  );
  return result;
}

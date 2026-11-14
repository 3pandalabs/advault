import "dotenv/config";

// Image-to-video motion clips. Turns a still storefront photo into a few
// seconds of moving footage, which is what makes a generated ad stop looking
// like a slideshow.
//
// EVERY provider here is optional, and the fallback is not a stub — it is the
// Ken Burns pan the renderer already ships and that produced the verified
// 1920x1080 / 1080x1920 output. So an unconfigured or failing motion provider
// costs polish, never a failed render. That matters more than it sounds: these
// APIs are slow (tens of seconds per clip), metered, and the newest thing in
// the stack. Making them load-bearing would make every render as reliable as
// the least reliable vendor.

export type MotionRequest = {
  imageBytes: Buffer;
  contentType: string;
  /**
   * A publicly-reachable URL for the same image. Luma takes a URL rather than
   * bytes, so the renderer passes a short-lived R2 presigned GET alongside the
   * bytes and each provider uses whichever form it wants. Optional because the
   * Kling path never needs it — a caller with no URL to offer simply cannot use
   * Luma, which `isConfigured()` cannot express and `generate()` therefore
   * rejects explicitly.
   */
  imageUrl?: string;
  /** What should happen in the shot. Derived from the scene caption. */
  prompt: string;
  durationSeconds: number;
  aspectRatio: "16:9" | "9:16";
};

export type MotionResult = { videoBytes: Buffer; source: "kling" | "luma" | "fal-kling" };

export interface MotionProvider {
  readonly name: "kling" | "luma" | "fal";
  isConfigured(): boolean;
  generate(req: MotionRequest): Promise<MotionResult>;
}

// Poll ceiling. Both vendors are async job APIs, and a render job that waits
// forever on a stuck vendor job holds a renderer slot — with RENDER_CONCURRENCY
// at 1, that is the entire render capacity of the platform.
const MAX_POLL_MS = 180_000;
const POLL_INTERVAL_MS = 5_000;

async function poll<T>(
  check: () => Promise<{ done: boolean; value?: T }>,
): Promise<T> {
  const deadline = Date.now() + MAX_POLL_MS;
  while (Date.now() < deadline) {
    const { done, value } = await check();
    if (done && value !== undefined) return value;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error("motion generation timed out");
}

// --- Kling v2.5 Turbo ------------------------------------------------------

const KLING_KEY = process.env.KLING_API_KEY;
// Singapore host, same default as ../cinematic. The bare api.klingai.com is
// the China-mainland endpoint and fails from Germany as if the key were wrong.
const KLING_BASE = process.env.KLING_API_BASE ?? "https://api-singapore.klingai.com/v1";

export const kling: MotionProvider = {
  name: "kling",
  isConfigured: () => Boolean(KLING_KEY),

  async generate(req) {
    const create = await fetch(`${KLING_BASE}/videos/image2video`, {
      method: "POST",
      headers: { authorization: `Bearer ${KLING_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        model_name: "kling-v2-5-turbo",
        image: req.imageBytes.toString("base64"),
        prompt: req.prompt,
        duration: String(Math.min(req.durationSeconds, 5)),
        aspect_ratio: req.aspectRatio === "9:16" ? "9:16" : "16:9",
      }),
    });
    if (!create.ok) {
      // Keep Kling's body: its status codes are ambiguous ("balance not enough"
      // is a 429, a discontinued model a 404) and the message is the diagnosis.
      throw new Error(`Kling create failed: ${create.status} ${(await create.text()).slice(0, 300)}`);
    }
    const { data } = (await create.json()) as { data?: { task_id?: string } };
    const taskId = data?.task_id;
    if (!taskId) throw new Error("Kling returned no task id");

    const url = await poll<string>(async () => {
      const res = await fetch(`${KLING_BASE}/videos/image2video/${taskId}`, {
        headers: { authorization: `Bearer ${KLING_KEY}` },
      });
      if (!res.ok) return { done: false };
      const body = (await res.json()) as {
        data?: { task_status?: string; task_result?: { videos?: { url?: string }[] } };
      };
      const status = body.data?.task_status;
      if (status === "failed") throw new Error("Kling reported task failure");
      const videoUrl = body.data?.task_result?.videos?.[0]?.url;
      return videoUrl ? { done: true, value: videoUrl } : { done: false };
    });

    const dl = await fetch(url);
    if (!dl.ok) throw new Error(`Kling download failed: ${dl.status}`);
    return { videoBytes: Buffer.from(await dl.arrayBuffer()), source: "kling" };
  },
};

// --- Luma Ray Flash 2 ------------------------------------------------------

const LUMA_KEY = process.env.LUMA_API_KEY;
const LUMA_BASE = process.env.LUMA_API_BASE ?? "https://api.lumalabs.ai/dream-machine/v1";

export const luma: MotionProvider = {
  name: "luma",
  isConfigured: () => Boolean(LUMA_KEY),

  async generate(req) {
    // Luma takes an image URL rather than bytes — the one asymmetry between the
    // two providers. Without `keyframes.frame0` this endpoint is text-to-video:
    // it would happily return a perfectly good clip of something that is not the
    // advertiser's storefront, which is a worse failure than an error because
    // nothing downstream can detect it.
    if (!req.imageUrl) throw new Error("Luma requires imageUrl (a reachable source frame)");

    const create = await fetch(`${LUMA_BASE}/generations`, {
      method: "POST",
      headers: { authorization: `Bearer ${LUMA_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "ray-flash-2",
        prompt: req.prompt,
        aspect_ratio: req.aspectRatio,
        duration: `${Math.min(req.durationSeconds, 5)}s`,
        keyframes: { frame0: { type: "image", url: req.imageUrl } },
      }),
    });
    if (!create.ok) {
      throw new Error(`Luma create failed: ${create.status} ${(await create.text()).slice(0, 300)}`);
    }
    const created = (await create.json()) as { id?: string };
    if (!created.id) throw new Error("Luma returned no generation id");

    const url = await poll<string>(async () => {
      const res = await fetch(`${LUMA_BASE}/generations/${created.id}`, {
        headers: { authorization: `Bearer ${LUMA_KEY}` },
      });
      if (!res.ok) return { done: false };
      const body = (await res.json()) as {
        state?: string;
        assets?: { video?: string };
      };
      if (body.state === "failed") throw new Error("Luma reported generation failure");
      return body.assets?.video ? { done: true, value: body.assets.video } : { done: false };
    });

    const dl = await fetch(url);
    if (!dl.ok) throw new Error(`Luma download failed: ${dl.status}`);
    return { videoBytes: Buffer.from(await dl.arrayBuffer()), source: "luma" };
  },
};

// --- Kling through fal (the demo ads' motion) --------------------------------
//
// 2026-11-13: the direct Kling account above ran out of credits in October
// ("Account balance not enough", code 1102), so every clip failed and every
// ad fell back to Ken Burns stills. fal's Kling (MOTION_PROVIDER=fal, FAL_KEY)
// is what the home-page demos were made with. One fixed motion prompt, not
// the caption: a caption ("$10 off your first cut") is not a camera direction,
// and a fixed prompt lets the worker reuse one clip per photo across formats.

export const FAL_MOTION_PROMPT =
  "Small, natural movement: people keep doing what they are doing, hair, cloth, leaves and light move softly; slow gentle push-in. Realistic, steady, natural. No text, no logos, no new objects, faces stay the same.";
const FAL_MOTION_ENDPOINT = process.env.FAL_MOTION_ENDPOINT ?? "kling/v4/flash/image-to-video";

export const falKling: MotionProvider = {
  name: "fal",
  isConfigured: () => Boolean(process.env.FAL_KEY),

  async generate(req) {
    const headers = { authorization: `Key ${process.env.FAL_KEY}`, "content-type": "application/json" };
    const image = `data:${req.contentType};base64,${req.imageBytes.toString("base64")}`;
    const submit = await fetch(`https://queue.fal.run/${FAL_MOTION_ENDPOINT}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ start_image_url: image, prompt: FAL_MOTION_PROMPT, duration: 5 }),
      signal: AbortSignal.timeout(60_000),
    });
    const job = (await submit.json().catch(() => ({}))) as { status_url?: string; response_url?: string };
    if (!submit.ok || !job.status_url || !job.response_url) {
      throw new Error(`fal motion submit failed: ${submit.status} ${JSON.stringify(job).slice(0, 300)}`);
    }
    await poll(async () => {
      const st = (await (await fetch(job.status_url!, { headers })).json()) as { status?: string; error?: unknown };
      if (st.status === "FAILED" || st.error) throw new Error(`fal motion failed: ${JSON.stringify(st).slice(0, 300)}`);
      return st.status === "COMPLETED" ? { done: true, value: true } : { done: false };
    });
    const out = (await (await fetch(job.response_url, { headers })).json()) as { video?: { url?: string } };
    if (!out.video?.url) throw new Error("fal motion returned no video");
    const dl = await fetch(out.video.url);
    if (!dl.ok) throw new Error(`fal motion download failed: ${dl.status}`);
    return { videoBytes: Buffer.from(await dl.arrayBuffer()), source: "fal-kling" };
  },
};

/** The configured provider, or null — null means "use Ken Burns", not "fail". */
export function motionProvider(): MotionProvider | null {
  const preferred = process.env.MOTION_PROVIDER;
  if (preferred === "fal") return falKling.isConfigured() ? falKling : null;
  if (preferred === "kling") return kling.isConfigured() ? kling : null;
  if (preferred === "luma") return luma.isConfigured() ? luma : null;
  if (kling.isConfigured()) return kling;
  if (luma.isConfigured()) return luma;
  return null;
}

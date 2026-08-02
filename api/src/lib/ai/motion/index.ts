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
  /** What should happen in the shot. Derived from the scene caption. */
  prompt: string;
  durationSeconds: number;
  aspectRatio: "16:9" | "9:16";
};

export type MotionResult = { videoBytes: Buffer; source: "kling" | "luma" };

export interface MotionProvider {
  readonly name: "kling" | "luma";
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
const KLING_BASE = process.env.KLING_API_BASE ?? "https://api.klingai.com/v1";

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
    if (!create.ok) throw new Error(`Kling create failed: ${create.status}`);
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
    // Luma takes an image URL rather than bytes, so this path needs a
    // publicly-reachable source frame. The renderer passes a short-lived R2
    // presigned URL via `prompt` metadata rather than uploading anywhere new —
    // see render/worker.ts. Kept explicit because it is the one asymmetry
    // between the two providers.
    const create = await fetch(`${LUMA_BASE}/generations`, {
      method: "POST",
      headers: { authorization: `Bearer ${LUMA_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "ray-flash-2",
        prompt: req.prompt,
        aspect_ratio: req.aspectRatio,
        duration: `${Math.min(req.durationSeconds, 5)}s`,
      }),
    });
    if (!create.ok) throw new Error(`Luma create failed: ${create.status}`);
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

/** The configured provider, or null — null means "use Ken Burns", not "fail". */
export function motionProvider(): MotionProvider | null {
  const preferred = process.env.MOTION_PROVIDER;
  if (preferred === "kling") return kling.isConfigured() ? kling : null;
  if (preferred === "luma") return luma.isConfigured() ? luma : null;
  if (kling.isConfigured()) return kling;
  if (luma.isConfigured()) return luma;
  return null;
}

import "dotenv/config";

// TEXT-to-video. The sibling ../motion module is IMAGE-to-video, and the
// difference is the entire product argument for the cinematic add-on.
//
// Image-to-video animates a photo the advertiser uploaded, so the photo is the
// ceiling: a badly lit storefront JPEG cannot be relit by a model only allowed
// to move within it. We measured that — a real Kling clip came back visually
// indistinguishable from the free zoompan filter. Text-to-video hands the model
// the whole frame, so it owns the lighting, the lens and the composition, which
// is why vendor showreels look the way they do.
//
// UNLIKE ../motion, THERE IS NO FALLBACK HERE. Motion is polish on a free
// render, so an unconfigured vendor costs nothing. This footage is the thing
// the advertiser paid for, so a failure must surface as a failed order and a
// refund — never as a quietly downgraded ad.

export type CinematicRequest = {
  prompt: string;
  seconds: number;
  aspectRatio: "16:9" | "9:16";
};

export type CinematicResult = {
  videoBytes: Buffer;
  source: "veo" | "kling";
  /** What the vendor actually billed for, which may be rounded up from `seconds`. */
  billedSeconds: number;
};

export interface CinematicProvider {
  readonly name: "veo" | "kling";
  isConfigured(): boolean;
  generate(req: CinematicRequest): Promise<CinematicResult>;
}

// Text-to-video is slower than image-to-video and a stuck vendor job holds a
// renderer slot — with RENDER_CONCURRENCY at 1 that is the platform's entire
// render capacity. Longer than the motion ceiling because these jobs genuinely
// take minutes, not seconds.
const MAX_POLL_MS = 420_000;
const POLL_INTERVAL_MS = 10_000;

async function poll<T>(check: () => Promise<{ done: boolean; value?: T }>): Promise<T> {
  const deadline = Date.now() + MAX_POLL_MS;
  while (Date.now() < deadline) {
    const { done, value } = await check();
    if (done && value !== undefined) return value;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error("cinematic generation timed out");
}

// --- Google Veo, via the Gemini API ----------------------------------------
//
// Note this is the GEMINI API key, not the Google Ads OAuth credentials
// elsewhere in this codebase. Different Google product, different account,
// different failure mode — do not reuse one for the other.

const VEO_KEY = process.env.GEMINI_API_KEY;
const VEO_BASE = process.env.GEMINI_API_BASE ?? "https://generativelanguage.googleapis.com/v1beta";
// Overridable because Veo model ids move faster than this repo does, and a
// hardcoded preview id is a time bomb. Fast rather than Standard by default:
// 4x cheaper per second, and 720p is not what makes an ad look cheap.
const VEO_MODEL = process.env.VEO_MODEL ?? "veo-3.1-fast-generate-preview";

export const veo: CinematicProvider = {
  name: "veo",
  isConfigured: () => Boolean(VEO_KEY),

  async generate(req) {
    const start = await fetch(`${VEO_BASE}/models/${VEO_MODEL}:predictLongRunning`, {
      method: "POST",
      headers: { "x-goog-api-key": VEO_KEY!, "content-type": "application/json" },
      body: JSON.stringify({
        instances: [{ prompt: req.prompt }],
        parameters: {
          aspectRatio: req.aspectRatio,
          durationSeconds: req.seconds,
          // One sample. The API will happily return several and bill for all
          // of them, which on a fixed-price product is margin straight out.
          sampleCount: 1,
        },
      }),
    });
    if (!start.ok) {
      throw new Error(`Veo request failed: ${start.status} ${(await start.text()).slice(0, 300)}`);
    }
    const { name } = (await start.json()) as { name?: string };
    if (!name) throw new Error("Veo returned no operation name");

    const uri = await poll<string>(async () => {
      const res = await fetch(`${VEO_BASE}/${name}`, {
        headers: { "x-goog-api-key": VEO_KEY! },
      });
      if (!res.ok) return { done: false };
      const body = (await res.json()) as {
        done?: boolean;
        error?: { message?: string };
        response?: {
          generateVideoResponse?: { generatedSamples?: { video?: { uri?: string } }[] };
        };
      };
      if (body.error) throw new Error(`Veo reported failure: ${body.error.message ?? "unknown"}`);
      if (!body.done) return { done: false };
      const found = body.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;
      if (!found) throw new Error("Veo finished without returning a video");
      return { done: true, value: found };
    });

    // The download URI is itself API-key authenticated — fetching it bare
    // returns a 403 that reads like a generation failure.
    const dl = await fetch(uri, { headers: { "x-goog-api-key": VEO_KEY! } });
    if (!dl.ok) throw new Error(`Veo download failed: ${dl.status}`);
    return {
      videoBytes: Buffer.from(await dl.arrayBuffer()),
      source: "veo",
      billedSeconds: req.seconds,
    };
  },
};

// --- Kling text-to-video ----------------------------------------------------
//
// Same account and key as the image-to-video path in ../motion, different
// endpoint. Kept as a second provider because it has no native audio and is
// cheaper — useful when the voiceover is coming from our own TTS anyway.

const KLING_KEY = process.env.KLING_API_KEY;
// Defaults to the Singapore host, NOT api.klingai.com. The bare hostname is
// the China-mainland endpoint and the renderer runs in Germany; getting this
// wrong presents as an authentication error rather than a routing one.
const KLING_BASE = process.env.KLING_API_BASE ?? "https://api-singapore.klingai.com/v1";
const KLING_T2V_MODEL = process.env.KLING_T2V_MODEL ?? "kling-v2-5-turbo";

export const klingText: CinematicProvider = {
  name: "kling",
  isConfigured: () => Boolean(KLING_KEY),

  async generate(req) {
    // Kling bills in 5s and 10s units, so a 7-second shot is charged as 10.
    // Rounded here rather than silently at the vendor, so the number we log as
    // billed is the number on the invoice.
    const billed = req.seconds <= 5 ? 5 : 10;

    const create = await fetch(`${KLING_BASE}/videos/text2video`, {
      method: "POST",
      headers: { authorization: `Bearer ${KLING_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        model_name: KLING_T2V_MODEL,
        prompt: req.prompt,
        duration: String(billed),
        aspect_ratio: req.aspectRatio,
        mode: "pro",
      }),
    });
    if (!create.ok) {
      throw new Error(`Kling create failed: ${create.status} ${(await create.text()).slice(0, 300)}`);
    }
    const { data } = (await create.json()) as { data?: { task_id?: string } };
    const taskId = data?.task_id;
    if (!taskId) throw new Error("Kling returned no task id");

    const url = await poll<string>(async () => {
      const res = await fetch(`${KLING_BASE}/videos/text2video/${taskId}`, {
        headers: { authorization: `Bearer ${KLING_KEY}` },
      });
      if (!res.ok) return { done: false };
      const body = (await res.json()) as {
        data?: { task_status?: string; task_result?: { videos?: { url?: string }[] } };
      };
      if (body.data?.task_status === "failed") throw new Error("Kling reported task failure");
      const videoUrl = body.data?.task_result?.videos?.[0]?.url;
      return videoUrl ? { done: true, value: videoUrl } : { done: false };
    });

    const dl = await fetch(url);
    if (!dl.ok) throw new Error(`Kling download failed: ${dl.status}`);
    return {
      videoBytes: Buffer.from(await dl.arrayBuffer()),
      source: "kling",
      billedSeconds: billed,
    };
  },
};

/**
 * The configured provider, or null.
 *
 * Null means "cannot sell a cinematic ad right now" — not "use something
 * cheaper". Callers must refuse the order rather than degrade it.
 */
export function cinematicProvider(): CinematicProvider | null {
  const preferred = process.env.CINEMATIC_PROVIDER;
  if (preferred === "veo") return veo.isConfigured() ? veo : null;
  if (preferred === "kling") return klingText.isConfigured() ? klingText : null;
  // Veo first when both are available: it generates synchronised dialogue
  // natively, which is the whole reason the output reads as a film rather than
  // a slideshow with narration bolted on.
  if (veo.isConfigured()) return veo;
  if (klingText.isConfigured()) return klingText;
  return null;
}

export function isCinematicConfigured(): boolean {
  return cinematicProvider() !== null;
}

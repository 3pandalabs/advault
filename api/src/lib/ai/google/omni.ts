import { createSign } from "node:crypto";

// Gemini Omni straight from Google (Vertex AI, now "Gemini Enterprise Agent
// Platform"), 2026-11-15. The SAME model AdVault already buys through fal
// (google/gemini-omni-flash/v1.2), so the footage looks the same; the reason
// to call Google directly is credits: the Cloud free trial and, if approved,
// Google for Startups credits pay for it. At list price Google is the
// DEARER route (~$0.07/s at 720p vs fal's ~$0.027/s), so the order is a
// setting, not a constant:
//
//   OMNI_PROVIDERS=vertex,fal   Google first (while credits last), fal backup
//   OMNI_PROVIDERS=fal          fal only (the default)
//
// Callers (motion clips, the mixed-ad opener, cinematic shots) try Google
// first when it leads the list and fall back to fal on ANY error, so an
// exhausted credit, a quota or an outage costs nothing but the fal price.
//
// Auth is a service-account key (GOOGLE_SA_KEY_B64 = the downloaded JSON key,
// base64) exchanged for a one-hour OAuth token, signed here with node:crypto
// rather than adding google-auth-library for one call. The account needs the
// Vertex AI User role on the project; the project id comes from the key.
//
// API shape (Interactions API, checked against Google's docs 2026-11-14):
// POST .../locations/global/interactions with background:true, poll
// GET .../interactions/{id} until status "completed", the MP4 comes back
// inline (base64) in steps[type=model_output].content[type=video].data.
// Omni always generates an audio track; every caller plays clips muted.

type ServiceAccount = { client_email: string; private_key: string; project_id: string };

function serviceAccount(): ServiceAccount | null {
  const b64 = process.env.GOOGLE_SA_KEY_B64;
  if (!b64) return null;
  try {
    const sa = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as Partial<ServiceAccount>;
    return sa.client_email && sa.private_key && sa.project_id ? (sa as ServiceAccount) : null;
  } catch {
    return null;
  }
}

export function vertexOmniConfigured(): boolean {
  return serviceAccount() !== null;
}

/** True when Google should be tried before fal for Omni footage. */
export function vertexOmniFirst(): boolean {
  const order = (process.env.OMNI_PROVIDERS ?? "fal").split(",").map((s) => s.trim());
  return order[0] === "vertex" && vertexOmniConfigured();
}

let cached: { token: string; expires: number } | null = null;

const b64url = (b: Buffer | string) =>
  Buffer.from(b).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

async function accessToken(sa: ServiceAccount): Promise<string> {
  if (cached && cached.expires > Date.now() + 60_000) return cached.token;
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/cloud-platform",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }),
  );
  const signature = b64url(createSign("RSA-SHA256").update(`${header}.${claims}`).sign(sa.private_key));
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${header}.${claims}.${signature}`,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number };
  if (!res.ok || !json.access_token) throw new Error(`google token exchange failed: ${res.status}`);
  cached = { token: json.access_token, expires: Date.now() + (json.expires_in ?? 3600) * 1000 };
  return json.access_token;
}

const MODEL = process.env.VERTEX_OMNI_MODEL ?? "gemini-omni-1.2-flash";
const MAX_WAIT_MS = 10 * 60_000;
const POLL_MS = 5_000;

export type OmniRequest = {
  prompt: string;
  seconds: number;
  aspectRatio: "16:9" | "9:16";
  /** Image-to-video when present: the clip starts from this photo. */
  image?: { bytes: Buffer; mimeType: string };
};

/** One Omni clip from Google. Throws on anything short of an MP4. */
export async function vertexOmniGenerate(req: OmniRequest): Promise<Buffer> {
  const sa = serviceAccount();
  if (!sa) throw new Error("vertex omni is not configured (GOOGLE_SA_KEY_B64)");
  const base = `https://aiplatform.googleapis.com/v1beta1/projects/${sa.project_id}/locations/global/interactions`;
  const call = async (url: string, init: RequestInit = {}) => {
    const res = await fetch(url, {
      ...init,
      headers: { authorization: `Bearer ${await accessToken(sa)}`, "content-type": "application/json" },
      signal: AbortSignal.timeout(120_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`vertex omni ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text) as Record<string, unknown>;
  };

  const seconds = Math.min(15, Math.max(3, Math.round(req.seconds)));
  const input: unknown[] = [
    {
      type: "text",
      // Omni defaults to multi-shot clips with dialogue; an ad clip is one shot.
      text: `${req.prompt} Single continuous shot, no scene cuts. No dialogue, no music.`,
    },
  ];
  if (req.image) {
    input.push({ type: "image", data: req.image.bytes.toString("base64"), mime_type: req.image.mimeType });
  }
  const created = await call(base, {
    method: "POST",
    body: JSON.stringify({
      model: MODEL,
      background: true,
      input,
      response_format: [
        { type: "video", delivery: "inline", aspect_ratio: req.aspectRatio, resolution: "720p", duration: `${seconds}s` },
      ],
      generation_config: { video_config: { task: req.image ? "image_to_video" : "text_to_video" } },
    }),
  });
  const id = created.id as string | undefined;
  if (!id) throw new Error(`vertex omni returned no interaction id: ${JSON.stringify(created).slice(0, 300)}`);

  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const it = await call(`${base}/${id}`);
    const status = it.status as string | undefined;
    if (status === "completed") {
      const steps = (it.steps ?? []) as { type?: string; content?: { type?: string; data?: string }[] }[];
      const video = steps.find((s) => s.type === "model_output")?.content?.find((c) => c.type === "video");
      if (!video?.data) throw new Error("vertex omni completed without inline video");
      return Buffer.from(video.data, "base64");
    }
    if (status && ["failed", "cancelled", "incomplete"].includes(status)) {
      throw new Error(`vertex omni ${status}: ${JSON.stringify(it.error ?? it).slice(0, 300)}`);
    }
  }
  throw new Error("vertex omni timed out");
}

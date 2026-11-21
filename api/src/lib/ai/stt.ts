// Speech to text for WhatsApp voice notes (lib/offerSwap/whatsapp.ts): fal's
// Whisper (`fal-ai/whisper`, FAL_KEY, same queue API as the voice in
// lib/ai/voice). Cheap (billed per audio second, a 20 s note costs well under
// a cent) and capped hard before it is ever called (policy.ts
// transcriptionAllowed: size, length, 6 a day per owner). Any failure returns
// null and the owner is asked to type the offer instead.

const ENDPOINT = process.env.FAL_STT_ENDPOINT ?? "fal-ai/whisper";
const TIMEOUT_MS = 90_000;

export function isSttConfigured(): boolean {
  return Boolean(process.env.FAL_KEY) && process.env.STT_PROVIDER !== "off";
}

/** Transcribes audio at a (short-lived, presigned) URL. Null on any failure. */
export async function transcribe(audioUrl: string, opts: { fetchImpl?: typeof fetch } = {}): Promise<string | null> {
  if (!isSttConfigured()) return null;
  const f = opts.fetchImpl ?? fetch;
  const headers = { authorization: `Key ${process.env.FAL_KEY}`, "content-type": "application/json" };
  try {
    const submit = await f(`https://queue.fal.run/${ENDPOINT}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ audio_url: audioUrl, task: "transcribe", chunk_level: "segment" }),
      signal: AbortSignal.timeout(30_000),
    });
    const job = (await submit.json().catch(() => ({}))) as { status_url?: string; response_url?: string };
    if (!submit.ok || !job.status_url || !job.response_url) return null;
    const started = Date.now();
    for (;;) {
      await new Promise((r) => setTimeout(r, 1500));
      const st = (await (await f(job.status_url, { headers, signal: AbortSignal.timeout(15_000) })).json()) as { status?: string; error?: unknown };
      if (st.status === "COMPLETED") break;
      if (st.status === "FAILED" || st.error) return null;
      if (Date.now() - started > TIMEOUT_MS) return null;
    }
    const out = (await (await f(job.response_url, { headers, signal: AbortSignal.timeout(15_000) })).json()) as { text?: string };
    const text = out.text?.replace(/\s+/g, " ").trim();
    return text ? text.slice(0, 500) : null;
  } catch {
    return null;
  }
}

import { createHmac, timingSafeEqual } from "node:crypto";

// WhatsApp Cloud API (Meta).
//
// This is the product's real interface, not a notification channel. A shop
// owner will not open a dashboard on the 1st of the month; they will reply to a
// message. So the monthly offer conversation happens here, and the dashboard is
// the fallback for people who prefer one.
//
// THE CONSTRAINT THAT SHAPES THIS MODULE: outside a 24-hour window opened by
// the customer's own last message, Meta only permits pre-approved TEMPLATE
// messages. Our monthly prompt is by definition unsolicited — it is the thing
// that starts the conversation — so it MUST be a template, registered and
// approved in Meta's console before it will send. Everything after their reply
// is inside the window and can be free text.
//
// Sending free text outside the window does not error loudly; it returns a
// perfectly ordinary-looking failure that is easy to miss in aggregate. Hence
// `sendTemplate` and `sendText` are separate functions rather than one with a
// flag — the choice is forced at the call site.

const TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const APP_SECRET = process.env.WHATSAPP_APP_SECRET;
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
const GRAPH = process.env.WHATSAPP_API_URL ?? "https://graph.facebook.com/v21.0";

// Template names as registered in Meta's console. Changing a template's content
// there requires re-approval; changing its NAME requires a new template, so
// these are effectively permanent once live.
// Our templates are registered as en_US on the messaging account; a language
// code that doesn't match the registered one fails with #132001.
const TEMPLATE_LANGUAGE = process.env.WHATSAPP_TEMPLATE_LANGUAGE ?? "en_US";

export const TEMPLATES = {
  monthlyOfferPrompt: process.env.WHATSAPP_TEMPLATE_OFFER_PROMPT ?? "monthly_offer_prompt",
  offerReminder: process.env.WHATSAPP_TEMPLATE_OFFER_REMINDER ?? "monthly_offer_reminder",
  // "Change my offer" (lib/offerSwap). Sent only when the owner's 24-hour
  // window is closed (Google's approval often takes longer than a day);
  // inside the window the same news goes as free text.
  offerChangeLive: process.env.WHATSAPP_TEMPLATE_OFFER_CHANGE_LIVE ?? "offer_change_live",
  offerChangeEnded: process.env.WHATSAPP_TEMPLATE_OFFER_CHANGE_ENDED ?? "offer_change_ended",
  offerChangeProblem: process.env.WHATSAPP_TEMPLATE_OFFER_CHANGE_PROBLEM ?? "offer_change_problem",
} as const;

/**
 * The WhatsApp offer-CHANGE loop (lib/offerSwap/whatsapp.ts): Meta configured
 * AND switched on with OFFER_SWAP_WHATSAPP=on. Off, every part of it is a
 * no-op and evergreen owners use the web page only.
 */
export function offerSwapWhatsAppEnabled(): boolean {
  return whatsAppSendsEnabled() && process.env.OFFER_SWAP_WHATSAPP === "on";
}

/**
 * Master switch for anything we SEND on WhatsApp (2026-11-21). Credentials can
 * be on the server (so the webhook verifies and Meta can be wired up) while
 * nothing goes out: every send, the monthly offer-cycle prompts and the
 * offer-change loop need WHATSAPP_SENDS=on as well. Off = inert.
 */
export function whatsAppSendsEnabled(): boolean {
  return isWhatsAppConfigured() && process.env.WHATSAPP_SENDS === "on";
}

export function isWhatsAppConfigured(): boolean {
  return Boolean(TOKEN && PHONE_NUMBER_ID && APP_SECRET);
}

export class WhatsAppNotConfigured extends Error {
  constructor() {
    super("whatsapp_not_configured");
  }
}

export type SendResult = { providerRef: string };

async function post(body: unknown): Promise<SendResult> {
  if (!whatsAppSendsEnabled()) throw new WhatsAppNotConfigured();

  const res = await fetch(`${GRAPH}/${PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`WhatsApp send failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  }

  const json = (await res.json()) as { messages?: { id?: string }[] };
  return { providerRef: json.messages?.[0]?.id ?? "" };
}

/**
 * A pre-approved template. The only thing that may open a conversation.
 *
 * `params` fill the template's {{1}}, {{2}} … placeholders IN ORDER, so the
 * order here has to match what was registered with Meta. A mismatch renders a
 * message with the arguments transposed and sends it to a real customer.
 */
export async function sendTemplate(args: {
  to: string;
  template: string;
  params: string[];
  languageCode?: string;
}): Promise<SendResult> {
  return post({
    messaging_product: "whatsapp",
    to: args.to,
    type: "template",
    template: {
      name: args.template,
      language: { code: args.languageCode ?? TEMPLATE_LANGUAGE },
      components: args.params.length
        ? [
            {
              type: "body",
              parameters: args.params.map((text) => ({ type: "text", text })),
            },
          ]
        : [],
    },
  });
}

/**
 * Free text with up to three quick-reply buttons (YES / NO on a preview).
 * Inside the 24-hour window only, like sendText.
 */
export async function sendButtons(args: { to: string; body: string; buttons: { id: string; title: string }[] }): Promise<SendResult> {
  return post({
    messaging_product: "whatsapp",
    to: args.to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: args.body.slice(0, 1024) },
      action: {
        buttons: args.buttons.slice(0, 3).map((b) => ({ type: "reply", reply: { id: b.id, title: b.title.slice(0, 20) } })),
      },
    },
  });
}

/** A video by link (Meta fetches it at send time). Inside the window only. */
export async function sendVideo(args: { to: string; link: string; caption?: string }): Promise<SendResult> {
  return post({
    messaging_product: "whatsapp",
    to: args.to,
    type: "video",
    video: { link: args.link, ...(args.caption ? { caption: args.caption.slice(0, 1024) } : {}) },
  });
}

/**
 * Downloads an inbound photo / voice note. Two calls, per Meta's spec:
 * GET /{media-id} (a short-lived URL, mime type and size), then the URL with
 * the same bearer token. Refuses anything over `maxBytes` before downloading.
 */
export async function downloadMedia(
  mediaId: string,
  maxBytes: number,
): Promise<{ bytes: Buffer; mimeType: string } | { tooLarge: true }> {
  if (!isWhatsAppConfigured()) throw new WhatsAppNotConfigured();
  const meta = await fetch(`${GRAPH}/${encodeURIComponent(mediaId)}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!meta.ok) throw new Error(`WhatsApp media lookup failed: ${meta.status}`);
  const info = (await meta.json()) as { url?: string; mime_type?: string; file_size?: number };
  if (!info.url) throw new Error("WhatsApp media has no url");
  if ((info.file_size ?? 0) > maxBytes) return { tooLarge: true };
  const res = await fetch(info.url, { headers: { authorization: `Bearer ${TOKEN}` }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`WhatsApp media download failed: ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.byteLength > maxBytes) return { tooLarge: true };
  return { bytes, mimeType: info.mime_type ?? res.headers.get("content-type") ?? "application/octet-stream" };
}

/** Free text. Valid ONLY inside the 24-hour window opened by their last reply. */
export async function sendText(args: { to: string; body: string }): Promise<SendResult> {
  return post({
    messaging_product: "whatsapp",
    to: args.to,
    type: "text",
    text: { preview_url: false, body: args.body },
  });
}

/**
 * Meta's subscribe handshake. Returns the challenge to echo, or null.
 *
 * Compared with timingSafeEqual because this token is the only thing standing
 * between an attacker and pointing our webhook subscription at their own app.
 */
export function verifyChallenge(query: Record<string, unknown>): string | null {
  const mode = String(query["hub.mode"] ?? "");
  const token = String(query["hub.verify_token"] ?? "");
  const challenge = String(query["hub.challenge"] ?? "");
  if (mode !== "subscribe" || !VERIFY_TOKEN) return null;

  const a = Buffer.from(token);
  const b = Buffer.from(VERIFY_TOKEN);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return challenge;
}

/**
 * X-Hub-Signature-256 over the RAW body.
 *
 * Same trust boundary as the payment webhooks: an unverified inbound message is
 * an attacker choosing what a customer "said", which here means choosing the
 * text of an advertisement and approving it.
 */
export function verifyWebhookSignature(
  rawBody: string,
  headers: Record<string, string | undefined>,
): boolean {
  const header = headers["x-hub-signature-256"];
  if (!header || !APP_SECRET) return false;

  const provided = header.startsWith("sha256=") ? header.slice(7) : header;
  const expected = createHmac("sha256", APP_SECRET).update(rawBody).digest("hex");
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export type InboundMessage = {
  providerRef: string;
  from: string;
  body: string;
  timestamp: Date;
};

/** Every inbound kind the offer-change loop understands (parseInboundAll). */
export type InboundAny = InboundMessage & {
  kind: "text" | "image" | "audio" | "button";
  /** Photo / voice note media id (downloadMedia). */
  mediaId?: string;
  /** Quick-reply button id (interactive.button_reply.id or a template button payload). */
  buttonId?: string;
};

/**
 * Extracts inbound text messages from a verified webhook body.
 *
 * Non-text messages (images, audio, reactions) are dropped rather than
 * mishandled: an offer arriving as a voice note is real and worth supporting
 * later, but silently treating its empty caption as ad copy is not.
 */
export function parseInbound(rawBody: string): InboundMessage[] {
  return parseInboundAll(rawBody)
    .filter((m) => m.kind === "text")
    .map(({ providerRef, from, body, timestamp }) => ({ providerRef, from, body, timestamp }));
}

/**
 * Text, photos (with caption), voice notes / audio, and quick-reply button
 * taps from a verified webhook body. Reactions, stickers, locations, status
 * callbacks and anything else are dropped.
 */
export function parseInboundAll(rawBody: string): InboundAny[] {
  let payload: {
    entry?: {
      changes?: {
        value?: {
          messages?: {
            id?: string;
            from?: string;
            timestamp?: string;
            type?: string;
            text?: { body?: string };
            image?: { id?: string; caption?: string };
            audio?: { id?: string; voice?: boolean };
            interactive?: { type?: string; button_reply?: { id?: string; title?: string } };
            button?: { payload?: string; text?: string };
          }[];
        };
      }[];
    }[];
  };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return [];
  }

  const out: InboundAny[] = [];
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const msg of change.value?.messages ?? []) {
        if (!msg.id || !msg.from) continue;
        const base = { providerRef: msg.id, from: msg.from, timestamp: new Date(Number(msg.timestamp ?? 0) * 1000) };
        if (msg.type === "text") out.push({ ...base, kind: "text", body: msg.text?.body ?? "" });
        else if (msg.type === "image" && msg.image?.id) out.push({ ...base, kind: "image", body: msg.image.caption ?? "", mediaId: msg.image.id });
        else if (msg.type === "audio" && msg.audio?.id) out.push({ ...base, kind: "audio", body: "", mediaId: msg.audio.id });
        else if (msg.type === "interactive" && msg.interactive?.button_reply?.id) {
          out.push({ ...base, kind: "button", body: msg.interactive.button_reply.title ?? "", buttonId: msg.interactive.button_reply.id });
        } else if (msg.type === "button" && msg.button?.payload) {
          out.push({ ...base, kind: "button", body: msg.button.text ?? "", buttonId: msg.button.payload });
        }
      }
    }
  }
  return out;
}

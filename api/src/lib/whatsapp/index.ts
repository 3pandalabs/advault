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
export const TEMPLATES = {
  monthlyOfferPrompt: process.env.WHATSAPP_TEMPLATE_OFFER_PROMPT ?? "monthly_offer_prompt",
  offerReminder: process.env.WHATSAPP_TEMPLATE_OFFER_REMINDER ?? "monthly_offer_reminder",
} as const;

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
  if (!isWhatsAppConfigured()) throw new WhatsAppNotConfigured();

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
      language: { code: args.languageCode ?? "en" },
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

/**
 * Extracts inbound text messages from a verified webhook body.
 *
 * Non-text messages (images, audio, reactions) are dropped rather than
 * mishandled: an offer arriving as a voice note is real and worth supporting
 * later, but silently treating its empty caption as ad copy is not.
 */
export function parseInbound(rawBody: string): InboundMessage[] {
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

  const out: InboundMessage[] = [];
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const msg of change.value?.messages ?? []) {
        if (msg.type !== "text" || !msg.id || !msg.from) continue;
        out.push({
          providerRef: msg.id,
          from: msg.from,
          body: msg.text?.body ?? "",
          timestamp: new Date(Number(msg.timestamp ?? 0) * 1000),
        });
      }
    }
  }
  return out;
}

// An AdVault ad has no phone number: not on the end card, not behind the
// button (the click goes to the website). So "Call now" asks viewers to do
// something they can't. A call/text line is swapped for a website one unless
// the text carries the number itself ("Call 201-555-0123").

export const DEFAULT_CALL_TO_ACTION = "Visit our website";

const ASKS_TO_CALL =
  /^(please\s+)?(call|phone|ring|dial|text|whatsapp)\b|\b(call|phone|ring|dial|text|whatsapp)\s+(us|now|today)\b|\bgive us a (call|ring)\b/i;
// "Call-out from $49", "Text alerts" are services, not a request to phone.
const NOT_A_REQUEST = /^(call[- ]?outs?|text (alerts?|updates?))\b/i;

export function hasPhoneNumber(text: string): boolean {
  return text.replace(/\D/g, "").length >= 7;
}

/** The call to action to speak, show and send to Google. */
export function answerableCallToAction(cta: string): string {
  const t = cta.trim();
  if (hasPhoneNumber(t) || NOT_A_REQUEST.test(t) || !ASKS_TO_CALL.test(t)) return cta;
  return DEFAULT_CALL_TO_ACTION;
}

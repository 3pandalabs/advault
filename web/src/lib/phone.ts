// Phone input for WhatsApp (api lib/phone, migration 0048). The API stores
// E.164 and is the real check; this only builds "+<code> <number>" from the
// country select and the typed number, and catches obvious mistakes early.

export const COUNTRY_CODES = [
  { code: "1", label: "US / Canada +1" },
  { code: "91", label: "India +91" },
  { code: "44", label: "UK +44" },
  { code: "61", label: "Australia +61" },
  { code: "971", label: "UAE +971" },
] as const;

export const DEFAULT_COUNTRY_CODE = "1";

/** "+1" + "(551) 316-9594" -> "+1 (551) 316-9594". A number typed with its own "+" wins. */
export function composePhone(countryCode: string, number: string): string {
  const n = number.trim();
  if (!n) return "";
  if (n.startsWith("+") || n.startsWith("00")) return n;
  return `+${countryCode} ${n}`;
}

/** Same rule as the API's normalizePhone, for an early message only. */
export function looksLikePhone(full: string): boolean {
  let s = full.trim();
  if (s.startsWith("00")) s = `+${s.slice(2)}`;
  if (!s.startsWith("+") || !/^[0-9\s().-]+$/.test(s.slice(1))) return false;
  const digits = s.replace(/[^0-9]/g, "");
  return digits.length >= 8 && digits.length <= 15 && !digits.startsWith("0");
}

/** Splits a stored E.164 number into the select's code and the rest. */
export function splitPhone(e164: string | null | undefined): { countryCode: string; number: string } {
  if (!e164) return { countryCode: DEFAULT_COUNTRY_CODE, number: "" };
  const digits = e164.replace(/[^0-9]/g, "");
  const match = [...COUNTRY_CODES].sort((a, b) => b.code.length - a.code.length).find((c) => digits.startsWith(c.code));
  return match ? { countryCode: match.code, number: digits.slice(match.code.length) } : { countryCode: DEFAULT_COUNTRY_CODE, number: e164 };
}

export const WHATSAPP_OPT_IN_TEXT =
  "Message me on WhatsApp about my ads (offer changes, previews, when it goes live). Reply STOP any time.";

// Phone numbers are stored as E.164 ("+13323168453", 2026-11-21, migration
// 0048): WhatsApp reports the sender as E.164 digits without the plus, and an
// exact match is the only safe way to tie a message to an account (a
// last-10-digits match collides between countries, e.g. a US and an Indian
// number). The country code is required; formatting is not.

/** Digits after the leading "+" / "00", or null when the input is not a phone number. */
export function normalizePhone(input: string | null | undefined): string | null {
  if (typeof input !== "string") return null;
  let s = input.trim();
  if (!s) return null;
  if (s.startsWith("00")) s = `+${s.slice(2)}`;
  if (!s.startsWith("+")) return null; // country code required
  const rest = s.slice(1);
  // Only digits and the usual separators: "+1 (551) 316-9594", "+91 98765 43210".
  if (!/^[0-9\s().\-]+$/.test(rest)) return null;
  const digits = rest.replace(/[^0-9]/g, "");
  if (digits.length < 8 || digits.length > 15) return null;
  if (digits.startsWith("0")) return null; // no country code starts with 0
  return `+${digits}`;
}

/** A WhatsApp sender id ("15513169594") as E.164, or null. */
export function e164FromWhatsApp(from: string): string | null {
  return normalizePhone(`+${from.replace(/[^0-9]/g, "")}`);
}

/** "+13323168453" -> "https://wa.me/13323168453". */
export function waMeLink(e164: string): string {
  return `https://wa.me/${e164.replace(/[^0-9]/g, "")}`;
}

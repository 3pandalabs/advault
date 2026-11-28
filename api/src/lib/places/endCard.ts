// The Google rating line joins the end card's one line (lib/categories
// extras may already have put a dish or makes there). Max 60 characters, as
// script/schema.ts allows; if both don't fit, the rating wins (the extras line
// is already in the voiceover and sticker facts).
export const END_CARD_LINE_MAX = 60;

export function withEndCardLine<T extends { endCardLine?: string }>(script: T, line: string): T {
  const existing = script.endCardLine?.trim();
  const joined = existing ? `${existing} · ${line}` : line;
  return { ...script, endCardLine: joined.length <= END_CARD_LINE_MAX ? joined : line.slice(0, END_CARD_LINE_MAX) };
}

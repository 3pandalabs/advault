// The translation layer that makes this product possible.
//
// A shop owner writes "20% off cakes this August, we're a family bakery". A
// text-to-video model needs "shallow depth of field, warm tungsten key light,
// 50mm, slow dolly in on flour-dusted hands folding dough". The gap between
// those two sentences is the entire difference between a vendor showreel and
// mush, and closing it costs well under a cent.
//
// The system prompt is stable across every advertiser so it caches; everything
// about this business goes in the user turn.

export const CINEMATIC_BRIEF_SYSTEM_PROMPT = `You are a commercial director planning a short advertisement for a small local business. You write shot descriptions for a text-to-video model, and caption/voiceover copy for a human editor.

The advertisement has two parts, and keeping them separate is not a style preference — it is a legal requirement you must never violate:

GENERATED SHOTS carry atmosphere only. Light, texture, materials, hands, motion, weather, time of day. They are evocative footage that sets a mood.

CAPTIONS AND VOICEOVER carry every fact — the offer, the price, the business name, the deadline. These are rendered exactly by a video editor from the advertiser's own words.

Rules for visualPrompt, all of them absolute:

1. NEVER describe any text, writing, letters, numbers, signage, banners, posters, logos, chalkboards, menu boards, price tags, labels or receipts appearing in the frame. Video models render text as garbled characters, and a garbled price in a paid advertisement is worse than no price at all.
2. NEVER include digits, currency symbols, percentages, or the words "free", "off", "sale" or "discount".
3. NEVER depict a specific named product the business may not actually sell, and never imply a claim about quality, price or origin. If the advertiser says they are a bakery, you may film warm light on unspecified pastries; you may not film "the best croissant in town".
4. NEVER depict identifiable real people's faces, celebrities, brands, or copyrighted characters.
5. DO specify the cinematography concretely: lens and depth of field, light source and direction, camera movement, time of day, colour temperature, texture. This is what the model actually needs.
6. Each shot must stand alone. They are generated independently, so a shot that depends on continuity with another one will not match.

Rules for captions: at most a few words each, and drawn from what the advertiser actually told you. A caption may state the offer plainly. Use null when a shot is better left clean.

Rules for voiceover: natural spoken language, roughly 2.5 words per second of total runtime, ending with the call to action. State the offer and the business name. Never claim anything the advertiser did not tell you.

Return the number of shots you are asked for, no more.`;

export function buildCinematicUserPrompt(input: {
  businessName: string;
  businessCategory: string;
  /** The advertiser's own description, in their words. The most valuable input. */
  description: string;
  offerDetails?: string | null;
  callToAction: string;
  shotCount: number;
  totalSeconds: number;
  aspectRatio: "16:9" | "9:16";
  /** What their real closing photo shows, so the generated shots lead into it. */
  closingPhotoHint?: string | null;
}): string {
  const lines = [
    `Business: ${input.businessName}`,
    `Category: ${input.businessCategory}`,
    `In their own words: ${input.description}`,
  ];
  if (input.offerDetails) lines.push(`This month's offer: ${input.offerDetails}`);
  lines.push(
    `Call to action: ${input.callToAction}`,
    `Format: ${input.aspectRatio}${input.aspectRatio === "9:16" ? " (vertical, phone-held — keep the subject centred and close)" : " (widescreen)"}`,
    `Shots: exactly ${input.shotCount}`,
    `Total generated runtime: ${input.totalSeconds} seconds`,
  );
  if (input.closingPhotoHint) {
    lines.push(`The advertisement ends on the advertiser's real photograph: ${input.closingPhotoHint}. Your final generated shot should lead naturally into it.`);
  } else {
    lines.push(
      `The advertisement ends on the advertiser's own real photograph of their business. Your final generated shot should lead naturally into a real, unpolished photograph.`,
    );
  }
  return lines.join("\n");
}

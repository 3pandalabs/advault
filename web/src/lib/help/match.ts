// Matches a typed question to one of the helper's topics. Plain word matching,
// no AI and no network: it can only ever show text we wrote. Pure, so
// scripts/help-check.mjs can run it.

export type HelpTopic = {
  id: string;
  q: string;
  a: string;
  /** Words that point at this topic. A "two words" entry needs both and counts double. */
  keys: string[];
  links?: { label: string; href: string }[];
};

const STOP = new Set(
  "a an the i im ive my me we our you your is are am be do does did can could will would should how what when where which who why to of for on in at it its this that and or with if from by as so please need want have has there any some get about help hi hello hey tell know not no".split(" "),
);

/** "targeting" -> "target", "prices" -> "price": crude, but the same on both sides. */
function stem(w: string): string {
  for (const end of ["ing", "ed", "es", "s"]) if (w.length - end.length >= 4 && w.endsWith(end)) return w.slice(0, -end.length).replace(/e$/, "");
  return w.replace(/e$/, "");
}

export function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[\u2019']/g, "")
    .split(/[^a-z0-9$]+/)
    .filter((w) => w && !STOP.has(w))
    .map(stem);
}

/** Edit distance counting a swap of neighbours as one, capped at 3. */
function distance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i ? (j ? 0 : i) : j)));
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
    }
  return Math.min(3, d[a.length]![b.length]!);
}

/** How alike two stemmed words are: 1 the same, less for a likely typo, 0 different. */
function alike(typed: string, key: string): number {
  if (typed === key) return 1;
  const n = Math.min(typed.length, key.length);
  if (n < 5 || typed[0] !== key[0]) return 0;
  const d = distance(typed, key);
  if (d === 1) return 0.8;
  if (n >= 7 && d === 2) return 0.7;
  // Scrambled letters ("aiduince" for "audience").
  if (n >= 7 && typed.length === key.length && typed.at(-1) === key.at(-1)) {
    const left = [...key];
    for (const ch of typed) {
      const i = left.indexOf(ch);
      if (i >= 0) left.splice(i, 1);
    }
    if (left.length <= 1) return 0.7;
  }
  return 0;
}

// A word the helper already knows is never a typo of another ("change" is not "charge").
const best = (typed: string[], key: string, known: Set<string>) =>
  typed.reduce((m, w) => Math.max(m, known.has(w) ? (w === key ? 1 : 0) : alike(w, key)), 0);

/** Topics for a question, best first; empty when nothing fits well enough. */
export function matchTopics(question: string, topics: HelpTopic[]): HelpTopic[] {
  const typed = words(question);
  if (!typed.length) return [];
  const known = new Set(topics.flatMap((t) => t.keys.flatMap(words)));
  return topics
    .map((t) => {
      let score = 0;
      for (const key of t.keys) {
        const parts = words(key);
        const hits = parts.map((p) => best(typed, p, known));
        if (parts.length && hits.every((h) => h > 0)) score += (hits.reduce((x, y) => x + y, 0) / hits.length) * (parts.length > 1 ? 2.5 : 1);
      }
      return { t, score };
    })
    .filter((x) => x.score >= 0.7)
    .sort((x, y) => y.score - x.score)
    .slice(0, 3)
    .map((x) => x.t);
}

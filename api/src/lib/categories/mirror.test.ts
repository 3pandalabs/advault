// The per-category rules run in the API (the real boundary) and in the
// browser (the cards and the wizard). Each API module's <shared> block must
// appear word for word in its web mirror.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const WEB = join(__dirname, "../../../../web/src/lib/categories");

const MIRRORED = ["key.ts", "seasons.ts", "schedulePresets.ts", "badges.ts", "planOffer.ts", "claims.ts"];

function shared(text: string): string {
  const t = text.replace(/\r\n/g, "\n");
  const a = t.indexOf("// <shared>");
  const b = t.indexOf("// </shared>");
  if (a < 0 || b < a) throw new Error("no <shared> block");
  return t.slice(a, b + "// </shared>".length);
}

describe("web mirrors of lib/categories", () => {
  for (const file of MIRRORED) {
    it(`${file} matches web/src/lib/categories/${file}`, () => {
      const api = shared(readFileSync(join(__dirname, file), "utf8"));
      const web = shared(readFileSync(join(WEB, file), "utf8"));
      expect(api.length).toBeGreaterThan(300);
      expect(web).toBe(api);
    });
  }
});

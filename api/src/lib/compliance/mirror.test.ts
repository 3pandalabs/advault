// The compliance rules and texts run in the API (the real boundary) and in the
// browser (wizard, campaign page, signup). Each API module's <shared> block
// must appear word for word in its web mirror.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const WEB = join(__dirname, "../../../../web/src/lib/compliance");
const MIRRORED = ["claimRules.ts", "texts.ts"];

function shared(text: string): string {
  const t = text.replace(/\r\n/g, "\n");
  const a = t.indexOf("// <shared>");
  const b = t.indexOf("// </shared>");
  if (a < 0 || b < a) throw new Error("no <shared> block");
  return t.slice(a, b + "// </shared>".length);
}

describe("web mirrors of lib/compliance", () => {
  for (const file of MIRRORED) {
    it(`${file} matches web/src/lib/compliance/${file}`, () => {
      const api = shared(readFileSync(join(__dirname, file), "utf8"));
      const web = shared(readFileSync(join(WEB, file), "utf8"));
      expect(api.length).toBeGreaterThan(300);
      expect(web).toBe(api);
    });
  }
});

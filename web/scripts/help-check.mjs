// node scripts/help-check.mjs: the panda helper picks the right answer, typos
// included, and admits when it has none.
import assert from "node:assert";
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const src = new URL("../src/", import.meta.url);
registerHooks({
  resolve(spec, ctx, next) {
    if (!spec.startsWith("@/")) return next(spec, ctx);
    const url = new URL(spec.slice(2) + ".ts", src);
    return next(existsSync(fileURLToPath(url)) ? url.href : spec, ctx);
  },
});
const { matchTopics } = await import("../src/lib/help/match.ts");
const { TOPICS, STARTERS } = await import("../src/lib/help/topics.ts");

const CASES = {
  "how price is calcualted": "price",
  "How much does it cost per month?": "price",
  "what is the monthly fee": "price",
  "can i chnage target aiduince": "audience",
  "Can I change my target audience?": "audience",
  "can I pick zip codes": "audience",
  "can it show only on weekends": "schedule",
  "can I pay one time without a subscription": "once",
  "how do I cancel": "contract",
  "pause my ad": "pause",
  "can I get a refund": "unused",
  "how do I add more budget": "topup",
  "how many times will my ad be shown": "shown",
  "where are my results": "results",
  "i dont have a website": "website",
  "how to edit my website": "editsite",
  "do I need a youtube channel": "accounts",
  "change my offer": "offer",
  "can I use my own video": "video",
  "I am a realtor": "realty",
  "how do I get started": "start",
  "forgot my pasword": "login",
  "delete my account": "delete",
  "what is the weather in paris": null,
  "can I advertise on facebook": "where",
  "why is my ad not approved": "review",
  "how to change business name": null,
  "I want to change my card": null,
  "asdf qwer": null,
  "": null,
  "can I speak to a person": null,
};
let bad = 0;
for (const [q, want] of Object.entries(CASES)) {
  const got = matchTopics(q, TOPICS)[0]?.id ?? null;
  if (got !== want) {
    bad++;
    console.error(`"${q}": wanted ${want}, got ${got}`);
  }
}
assert.equal(new Set(TOPICS.map((t) => t.id)).size, TOPICS.length);
for (const id of STARTERS) assert(TOPICS.some((t) => t.id === id), id);
for (const t of TOPICS) assert.equal(matchTopics(t.q, TOPICS)[0]?.id, t.id, `its own question: ${t.q}`);
assert.equal(bad, 0);
console.log(`ok: ${Object.keys(CASES).length} questions, ${TOPICS.length} topics`);

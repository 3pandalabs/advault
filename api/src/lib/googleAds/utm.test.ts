import { describe, expect, it } from "vitest";
import { withAdUtm } from "./utm.js";

const ID = "3f0c9a52-1b2c-4d5e-8f90-123456789abc";
const TAGS = `utm_source=youtube&utm_medium=paid_video&utm_campaign=${ID}`;

describe("withAdUtm", () => {
  it("adds the three tags to a bare URL", () => {
    expect(withAdUtm("https://joesplumbing.com", ID)).toBe(`https://joesplumbing.com?${TAGS}`);
    expect(withAdUtm("https://joesplumbing.com/", ID)).toBe(`https://joesplumbing.com/?${TAGS}`);
  });

  it("keeps existing query params exactly as written", () => {
    expect(withAdUtm("https://x.com/a?ref=b%20c&q=1+2", ID)).toBe(`https://x.com/a?ref=b%20c&q=1+2&${TAGS}`);
  });

  it("puts the tags before the fragment", () => {
    expect(withAdUtm("https://x.com/menu#specials", ID)).toBe(`https://x.com/menu?${TAGS}#specials`);
    expect(withAdUtm("https://x.com/?a=1#top", ID)).toBe(`https://x.com/?a=1&${TAGS}#top`);
  });

  it("handles a trailing ? or &", () => {
    expect(withAdUtm("https://x.com/?", ID)).toBe(`https://x.com/?${TAGS}`);
    expect(withAdUtm("https://x.com/?a=1&", ID)).toBe(`https://x.com/?a=1&${TAGS}`);
  });

  it("never duplicates a tag the URL already has", () => {
    expect(withAdUtm(`https://x.com/?${TAGS}`, ID)).toBe(`https://x.com/?${TAGS}`);
    expect(withAdUtm("https://x.com/?utm_source=google", ID)).toBe(
      `https://x.com/?utm_source=google&utm_medium=paid_video&utm_campaign=${ID}`,
    );
  });

  it("is idempotent", () => {
    const once = withAdUtm("https://x.com/p?a=1#f", ID);
    expect(withAdUtm(once, ID)).toBe(once);
  });

  it("leaves unparseable or non-http URLs untouched", () => {
    expect(withAdUtm("not a url", ID)).toBe("not a url");
    expect(withAdUtm("mailto:joe@x.com", ID)).toBe("mailto:joe@x.com");
  });
});

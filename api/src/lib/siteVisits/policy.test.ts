import { describe, expect, it } from "vitest";
import { createIpLimiter, isCampaignId, landsOnAdvault, normalisePath } from "./policy.js";

describe("siteVisits policy", () => {
  it("accepts only uuid campaign ids", () => {
    expect(isCampaignId("3f0c9a52-1b2c-4d5e-8f90-123456789abc")).toBe(true);
    expect(isCampaignId("summer_sale")).toBe(false);
    expect(isCampaignId(undefined)).toBe(false);
  });

  it("knows which landing URLs we can see", () => {
    expect(landsOnAdvault("https://advault.3pandalabs.com/?a=1")).toBe(true);
    expect(landsOnAdvault("https://ADVAULT.3pandalabs.com")).toBe(true);
    expect(landsOnAdvault("https://joes.3pandasite.com")).toBe(false);
    expect(landsOnAdvault("https://advault.3pandalabs.com.evil.com")).toBe(false);
    expect(landsOnAdvault(null)).toBe(false);
    expect(landsOnAdvault("nope")).toBe(false);
  });

  it("keeps only a plain pathname", () => {
    expect(normalisePath("/signup?email=a@b.c#x")).toBe("/signup");
    expect(normalisePath("/a b")).toBe("/");
    expect(normalisePath("https://x.com/")).toBe("/");
    expect(normalisePath(undefined)).toBe("/");
    expect(normalisePath("/" + "a".repeat(300))).toHaveLength(120);
  });

  it("limits per IP per window", () => {
    const allow = createIpLimiter(2, 1000);
    expect([allow("a", 0), allow("a", 1), allow("a", 2), allow("b", 2)]).toEqual([true, true, false, true]);
    expect(allow("a", 1000)).toBe(true);
  });
});

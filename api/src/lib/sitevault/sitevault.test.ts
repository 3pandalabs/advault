import { describe, expect, it } from "vitest";
import { offerBanner, sitevaultCategory } from "./index.js";

describe("sitevaultCategory", () => {
  it("maps AdVault categories to SiteVault templates", () => {
    expect(sitevaultCategory("Landscaping")).toBe("landscaping");
    expect(sitevaultCategory("Dentistry")).toBe("dentist");
    expect(sitevaultCategory("Real estate")).toBe("realestate");
    expect(sitevaultCategory("Cleaning services")).toBe("cleaning");
    expect(sitevaultCategory("HVAC")).toBe("hvac");
    expect(sitevaultCategory("Hair salon")).toBe("salon");
    expect(sitevaultCategory("Other")).toBe("other");
  });
});

describe("offerBanner", () => {
  it("takes the first line, strips links, caps length", () => {
    expect(offerBanner("Spring cleanup $149 at www.shop.com\nmore")).toBe("Spring cleanup $149 at");
    expect(offerBanner("See https://x.example/deal now")).toBe("See now");
    expect(offerBanner(null)).toBe("");
    expect(offerBanner("a".repeat(200)).length).toBe(160);
  });
});

describe("from the ad's sticker", async () => {
  const { servicesFromSticker, taglineFromSticker, sentenceCase } = await import("./index.js");
  const sticker = {
    badge: "$149",
    headline: "SPRING CLEANUP",
    tagline: "FREE QUOTES, SAME WEEK",
    benefits: ["MOWING FROM $35 WEEKLY", "WITHIN 10 MILES OF 07094"],
  };
  it("builds services: headline + price, priced benefits, never the area line", () => {
    expect(servicesFromSticker(sticker)).toBe("Spring cleanup - $149\nMowing from $35 weekly");
  });
  it("uses the tagline as the one-liner", () => {
    expect(taglineFromSticker(sticker)).toBe("Free quotes, same week");
  });
  it("keeps short acronyms", () => {
    expect(sentenceCase("EV CHARGERS FROM $599")).toBe("EV chargers from $599");
    expect(sentenceCase("PANEL UPGRADE ESTIMATE")).toBe("Panel upgrade estimate");
  });
  it("is empty without a sticker", () => {
    expect(servicesFromSticker(null)).toBe("");
  });
});

describe("slugFromSiteUrl", async () => {
  const { slugFromSiteUrl } = await import("./index.js");
  it("reads the slug from new and old SiteVault links", () => {
    expect(slugFromSiteUrl("https://ekmoliya.3pandasite.com/")).toBe("ekmoliya");
    expect(slugFromSiteUrl("https://sitevault.3pandalabs.com/s/ekmoliya-secaucus-nj")).toBe("ekmoliya-secaucus-nj");
  });
  it("ignores other websites", () => {
    expect(slugFromSiteUrl("https://mikesplumbing.com")).toBeNull();
    expect(slugFromSiteUrl(null)).toBeNull();
  });
});

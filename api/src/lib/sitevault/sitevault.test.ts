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

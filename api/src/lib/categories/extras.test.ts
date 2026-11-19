import { describe, expect, it } from "vitest";
import {
  COMMON_MAKES,
  MAX_MAKES,
  extrasEndCardLine,
  extrasFacts,
  extrasFor,
  extrasProblem,
  neighborOfferText,
  offerPresets,
  parseZips,
  withSpotlightPhoto,
} from "./extras.js";
import { claimFlags } from "./claims.js";

describe("extrasFor", () => {
  it("restaurant, auto and landscaping get theirs; others none", () => {
    expect(extrasFor("restaurant")).toEqual(["spotlight", "orderUrl"]);
    expect(extrasFor("auto")).toEqual(["makes"]);
    expect(extrasFor("landscaping")).toEqual(["neighborZips"]);
    expect(extrasFor("plumbing")).toEqual([]);
    expect(extrasFor(null)).toEqual([]);
  });
});

describe("extrasProblem", () => {
  it("accepts valid extras and an empty object", () => {
    expect(extrasProblem("restaurant", { spotlight: { dish: "Margherita", price: "$14" }, orderUrl: "https://order.example.com/x" })).toBeNull();
    expect(extrasProblem("auto", { makes: ["Toyota", "Honda"] })).toBeNull();
    expect(extrasProblem("landscaping", { neighborZips: ["08817", "08820"] })).toBeNull();
    expect(extrasProblem("plumbing", {})).toBeNull();
  });

  it("refuses another category's extras", () => {
    expect(extrasProblem("plumbing", { makes: ["Ford"] })).toBe("extras_not_for_category");
    expect(extrasProblem("auto", { spotlight: { dish: "Pie" } })).toBe("extras_not_for_category");
    // An empty field from another category is fine (it means none).
    expect(extrasProblem("auto", { makes: ["Ford"], neighborZips: [] })).toBeNull();
  });

  it("checks each field", () => {
    expect(extrasProblem("restaurant", { spotlight: { dish: " " } })).toBe("spotlight_dish_required");
    expect(extrasProblem("restaurant", { spotlight: { dish: "x".repeat(41) } })).toBe("spotlight_too_long");
    expect(extrasProblem("restaurant", { orderUrl: "javascript:alert(1)" })).toBe("order_url_invalid");
    expect(extrasProblem("auto", { makes: Array.from({ length: MAX_MAKES + 1 }, (_, i) => `M${i}`) })).toBe("makes_invalid");
    expect(extrasProblem("landscaping", { neighborZips: ["08817", "560001"] })).toBe("neighbor_zips_invalid");
    expect(extrasProblem("landscaping", { neighborZips: ["0881"] })).toBe("neighbor_zips_invalid");
  });
});

describe("what reaches the ad", () => {
  it("restaurant: the dish is a fact and the end-card line", () => {
    const e = { spotlight: { dish: "Margherita", price: "$14" } };
    expect(extrasFacts("restaurant", e)).toEqual(["Featured dish: Margherita, $14. Make it the star of the ad."]);
    expect(extrasEndCardLine("restaurant", e)).toBe("Try our Margherita · $14");
    expect(extrasEndCardLine("restaurant", { spotlight: { dish: "Tacos" } })).toBe("Try our Tacos");
  });

  it("auto: the makes, cut to fit with '+ more'", () => {
    expect(extrasEndCardLine("auto", { makes: ["Toyota", "Honda", "Ford"] })).toBe("We service Toyota · Honda · Ford");
    const long = extrasEndCardLine("auto", { makes: [...COMMON_MAKES] })!;
    expect(long.endsWith("+ more")).toBe(true);
    expect(long.length).toBeLessThanOrEqual(60);
    expect(extrasFacts("auto", { makes: ["Toyota", "Honda"] })).toEqual(["Makes we service: Toyota, Honda."]);
  });

  it("nothing for a category whose extras these are not, or none", () => {
    expect(extrasEndCardLine("plumbing", { makes: ["Ford"] })).toBeNull();
    expect(extrasFacts("plumbing", { spotlight: { dish: "x" } })).toEqual([]);
    expect(extrasEndCardLine("auto", null)).toBeNull();
  });

  it("the dish photo leads, at most five photos", () => {
    expect(withSpotlightPhoto(["a", "b"], "d")).toEqual(["d", "a", "b"]);
    expect(withSpotlightPhoto(["a", "d", "b"], "d")).toEqual(["d", "a", "b"]);
    expect(withSpotlightPhoto(["a", "b", "c", "e", "f"], "d")).toEqual(["d", "a", "b", "c", "e"]);
    expect(withSpotlightPhoto(["a"], null)).toEqual(["a"]);
  });
});

describe("landscaping neighbors", () => {
  it("parses typed ZIPs, unique and in order", () => {
    expect(parseZips("08817, 08820 08817;08837\n")).toEqual(["08817", "08820", "08837"]);
  });

  it("writes neighbor-price copy, or nothing without a deal", () => {
    expect(neighborOfferText("$10 off your first mow.")).toBe(
      "Neighbor price: $10 off your first mow for homes near the yards we already care for. We're on your street every week.",
    );
    expect(neighborOfferText(" ")).toBeNull();
  });
});

describe("offer presets", () => {
  it("electrical upgrades and the cleaning move-out preset", () => {
    expect(offerPresets("electrical").map((p) => p.id)).toEqual(["ev-charger", "panel", "generator", "solar"]);
    expect(offerPresets("cleaning").map((p) => p.id)).toEqual(["move-out-in"]);
    expect(offerPresets("dentistry")).toEqual([]);
  });

  it("every preset passes its own category's claim checks and fits", () => {
    for (const k of ["electrical", "cleaning"] as const) {
      for (const p of offerPresets(k)) {
        expect(claimFlags(k, p.offer), p.id).toEqual([]);
        expect(p.callToAction.length).toBeLessThanOrEqual(40);
      }
    }
  });
});

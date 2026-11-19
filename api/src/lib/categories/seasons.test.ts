import { describe, expect, it } from "vitest";
import { CATEGORY_KEYS } from "./key.js";
import { SEASONS, alreadyUsingSeason, seasonCard } from "./seasons.js";

const US = { market: "US" as const };

describe("SEASONS", () => {
  it("every category has at least two seasons, each with an offer and a short CTA", () => {
    for (const k of CATEGORY_KEYS) {
      expect(SEASONS[k].length, k).toBeGreaterThanOrEqual(2);
      for (const s of SEASONS[k]) {
        expect(s.offer.length, s.id).toBeGreaterThan(20);
        expect(s.offer.length, s.id).toBeLessThanOrEqual(2000);
        expect(s.callToAction.length, s.id).toBeLessThanOrEqual(40);
        expect(Boolean(s.monthly) !== Boolean(s.from && s.to), s.id).toBe(true);
      }
    }
  });

  it("never quotes a daily budget", () => {
    for (const k of CATEGORY_KEYS) for (const s of SEASONS[k]) expect(s.offer).not.toMatch(/\/\s*day|a day\b|per day/i);
  });
});

describe("seasonCard: lawn care through the year", () => {
  const at = (d: string) => seasonCard("landscaping", d, US);

  it("suggests the next season inside the lead time", () => {
    expect(at("2026-08-20")).toMatchObject({ status: "soon", startsOn: "2026-09-01", title: "Fall is coming" });
    expect(at("2026-08-20")!.season.id).toBe("fall-leaves");
    expect(at("2026-02-10")!.season.id).toBe("spring-cleanup");
    expect(at("2026-11-15")!.season.id).toBe("winter-snow");
  });

  it("shows the running season otherwise", () => {
    expect(at("2026-07-01")).toMatchObject({ status: "now", title: "Summer is here" });
    expect(at("2026-07-01")!.season.id).toBe("summer-mowing");
  });

  it("winter wraps the new year", () => {
    expect(at("2027-01-15")).toMatchObject({ status: "now", startsOn: "2026-12-01" });
  });

  it("no snow in India: winter shows nothing until spring is near", () => {
    expect(seasonCard("landscaping", "2027-01-05", { market: "IN" })).toBeNull();
    expect(seasonCard("landscaping", "2027-02-15", { market: "IN" })!.season.id).toBe("spring-cleanup");
  });
});

describe("seasonCard: other categories", () => {
  it("dentistry: use your benefits from October", () => {
    expect(seasonCard("dentistry", "2026-10-20", US)!.season.id).toBe("use-benefits");
    expect(seasonCard("dentistry", "2026-09-15", US)).toMatchObject({ status: "soon", startsOn: "2026-10-01" });
  });

  it("HVAC: spring AC, fall furnace", () => {
    expect(seasonCard("hvac", "2026-03-01", US)!.season.id).toBe("spring-ac");
    expect(seasonCard("hvac", "2026-08-20", US)!.season.id).toBe("fall-furnace");
  });

  it("plumbing: frozen pipes in winter", () => {
    expect(seasonCard("plumbing", "2027-01-10", US)!.season.id).toBe("winter-pipes");
  });

  it("restaurant: holiday catering inside game season wins", () => {
    expect(seasonCard("restaurant", "2026-12-01", US)!.season.id).toBe("holiday-catering");
    expect(seasonCard("restaurant", "2026-10-01", US)!.season.id).toBe("game-day");
    expect(seasonCard("restaurant", "2027-01-20", US)!.season.id).toBe("valentines");
  });

  it("cleaning: month-end move-outs every month, close to the day", () => {
    expect(seasonCard("cleaning", "2026-10-10", US)).toBeNull();
    expect(seasonCard("cleaning", "2026-10-18", US)).toMatchObject({ status: "soon", startsOn: "2026-10-22" });
    expect(seasonCard("cleaning", "2026-06-25", US)!.season.id).toBe("month-end-move");
    // A 30-day month: the window ends on its last day.
    expect(seasonCard("cleaning", "2026-09-30", US)!.season.id).toBe("month-end-move");
  });

  it("real estate: agent ads only", () => {
    expect(seasonCard("realEstate", "2026-03-10", { market: "US", realtyAdType: "listing" })).toBeNull();
    expect(seasonCard("realEstate", "2026-03-10", { market: "US", realtyAdType: "agent" })!.season.id).toBe("spring-market");
  });

  it("null category or a bad date: nothing", () => {
    expect(seasonCard(null, "2026-03-10", US)).toBeNull();
    expect(seasonCard("hvac", "nope", US)).toBeNull();
  });
});

describe("alreadyUsingSeason", () => {
  it("matches the offer ignoring case and spacing", () => {
    const s = SEASONS.hvac[0]!;
    expect(alreadyUsingSeason(`  ${s.offer.toUpperCase()} `, s)).toBe(true);
    expect(alreadyUsingSeason("AC tune-up $69.", s)).toBe(false);
    expect(alreadyUsingSeason(null, s)).toBe(false);
  });
});

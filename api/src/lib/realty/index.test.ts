import { describe, expect, it } from "vitest";
import { bedsBaths, openHouseLong, openHouseTag, realtySchema, shortPrice } from "./index.js";
import { buildAdScriptUserPrompt } from "../script/prompt.js";
import { buildFallbackScript } from "../script/fallback.js";
import { adScriptSchema } from "../script/schema.js";

const addr = { street: "412 Maple Ave", city: "Austin", state: "TX", postalCode: "78701" };
const listing = { adType: "listing" as const, price: "$489,000", beds: 3, baths: 2.5, openHouse: { date: "2026-11-15", start: "13:00", end: "16:00" } };

describe("real estate ad facts", () => {
  it("formats the open house, price and size", () => {
    expect(openHouseLong(listing.openHouse)).toBe("Sunday, November 15, 1–4 PM");
    expect(openHouseLong({ date: "2026-11-15", start: "11:00", end: "14:30" })).toBe("Sunday, November 15, 11 AM–2:30 PM");
    expect(openHouseTag(listing.openHouse)).toBe("OPEN HOUSE SUN 1–4");
    expect(shortPrice("$489,000")).toBe("$489K");
    expect(shortPrice("1250000")).toBe("$1.25M");
    expect(bedsBaths(listing)).toBe("3 BED · 2.5 BATH");
  });

  it("validates input", () => {
    expect(realtySchema.safeParse(listing).success).toBe(true);
    expect(realtySchema.safeParse({ ...listing, openHouse: { date: "2026-11-15", start: "16:00", end: "13:00" } }).success).toBe(false);
    expect(realtySchema.safeParse({ adType: "agent" }).success).toBe(true);
  });

  it("gives the script writer the address and the open house", () => {
    const base = { businessName: "Dana Reyes Realty", businessCategory: "Real estate", callToAction: "Call Dana", targetZipCodes: [], radiusMiles: 5, aspectRatio: "9:16" as const, assetCount: 4, targetAddress: addr };
    const p = buildAdScriptUserPrompt({ ...base, realty: listing });
    expect(p).toContain("412 Maple Ave, Austin, TX");
    expect(p).toContain("Open house: Sunday, November 15, 1–4 PM");
    expect(p).toContain("LISTING ad");
    const agent = buildAdScriptUserPrompt({ ...base, realty: { adType: "agent" } });
    expect(agent).toContain("AGENT ad");
    expect(agent).not.toContain("Open house");
  });

  it("falls back to a listing script that says the address and open house", () => {
    const s = buildFallbackScript({ businessName: "Dana Reyes Realty", businessCategory: "Real estate", callToAction: "Call Dana", targetZipCodes: [], assetCount: 4, targetAddress: addr, realty: listing });
    expect(adScriptSchema.safeParse(s).success).toBe(true);
    expect(s.hook).toContain("412 Maple Ave");
    expect(s.voiceoverText).toContain("Open house Sunday, November 15, 1–4 PM");
    expect(s.sticker).toMatchObject({ badge: "$489K", headline: "3 BED · 2.5 BATH", tagline: "OPEN HOUSE SUN 1–4" });
    const agent = buildFallbackScript({ businessName: "Dana Reyes Realty", businessCategory: "Real estate", callToAction: "Call Dana", targetZipCodes: [], assetCount: 2, targetAddress: addr, realty: { adType: "agent" } });
    expect(adScriptSchema.safeParse(agent).success).toBe(true);
    expect(agent.scenes[1].caption).toBe("Your real estate agent in Austin, TX");
  });

  it("tells the script writer which photos show people and which is the agent", () => {
    const p = buildAdScriptUserPrompt({ businessName: "Dana Reyes Realty", businessCategory: "Real estate", callToAction: "Call Dana", targetZipCodes: [], radiusMiles: 5, aspectRatio: "9:16", assetCount: 4, targetAddress: addr, realty: listing, peopleIndexes: [1, 3], portraitIndex: 3 });
    expect(p).toContain("Photos showing real people from the business: 1.");
    expect(p).toContain("Photo 3 is the agent's own photo");
  });
});

import { describe, expect, it } from "vitest";
import { e164FromWhatsApp, normalizePhone, waMeLink } from "./index.js";

describe("normalizePhone (E.164)", () => {
  it("accepts formatted numbers with a country code", () => {
    expect(normalizePhone("+1 (551) 316-9594")).toBe("+15513169594");
    expect(normalizePhone("+91 98765 43210")).toBe("+919876543210");
    expect(normalizePhone("0091-98765-43210")).toBe("+919876543210");
    expect(normalizePhone(" +13323168453 ")).toBe("+13323168453");
  });
  it("rejects no country code, too short, too long, letters", () => {
    expect(normalizePhone("(551) 316-9594")).toBeNull();
    expect(normalizePhone("+1 234 56")).toBeNull();
    expect(normalizePhone("+1234567890123456")).toBeNull();
    expect(normalizePhone("+1 555 CALL NOW")).toBeNull();
    expect(normalizePhone("+0 555 123 4567")).toBeNull();
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone(null)).toBeNull();
  });
  it("WhatsApp sender ids and wa.me links", () => {
    expect(e164FromWhatsApp("15513169594")).toBe("+15513169594");
    expect(e164FromWhatsApp("12")).toBeNull();
    expect(waMeLink("+13323168453")).toBe("https://wa.me/13323168453");
  });
});

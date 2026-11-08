import { describe, expect, it } from "vitest";
import { asciiHeader } from "./notify.js";
import { cardNickname } from "../mercury/index.js";

describe("asciiHeader", () => {
  // HTTP header values must be ASCII; business names often are not.
  it("turns dashes and accents into plain ASCII", () => {
    expect(asciiHeader("AdVault – Café Ñandú")).toBe("AdVault - Cafe Nandu");
  });

  it("drops what it cannot transliterate", () => {
    expect(asciiHeader("Sharma सैलून Salon")).toBe("Sharma  Salon");
  });
});

describe("cardNickname", () => {
  it("names the card after the customer and stays short", () => {
    expect(cardNickname("Sharma Salon")).toBe("AdVault – Sharma Salon");
    expect(cardNickname("x".repeat(100)).length).toBe(60);
  });
});

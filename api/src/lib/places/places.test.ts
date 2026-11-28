import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DETAILS_FIELDS,
  adRatingLine,
  allowPlacesCall,
  cityFromAddress,
  placeDetails,
  ratingEligible,
  ratingLine,
  resetPlacesLimits,
  searchPlaces,
  zipFromAddress,
} from "./index.js";
import { withEndCardLine } from "./endCard.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

type Call = [string, RequestInit];
const mask = (c: unknown) => ((c as Call)[1].headers as Record<string, string>)["x-goog-fieldmask"];

describe("address parsing", () => {
  it("finds the ZIP / PIN and the town", () => {
    expect(zipFromAddress("123 Main St, Springfield, IL 62701, USA")).toBe("62701");
    expect(zipFromAddress("12 MG Road, Bengaluru, Karnataka 560001, India")).toBe("560001");
    expect(cityFromAddress("123 Main St, Springfield, IL 62701-1234, USA")).toBe("Springfield");
    expect(zipFromAddress("Somewhere")).toBeNull();
  });
});

describe("rating in the ad", () => {
  it("only from 4.0 stars and 5 reviews", () => {
    expect(ratingEligible(4.0, 5)).toBe(true);
    expect(ratingEligible(3.9, 500)).toBe(false);
    expect(ratingEligible(5, 4)).toBe(false);
    expect(ratingEligible(null, null)).toBe(false);
    expect(ratingLine(4.8, 1200)).toBe("★ 4.8 on Google (1,200 reviews)");
  });

  it("is fetched fresh, and dropped when not eligible or not wanted", async () => {
    vi.stubEnv("GOOGLE_PLACES_API_KEY", "k");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ rating: 4.6, userRatingCount: 37 })));
    vi.stubGlobal("fetch", fetchMock);
    expect(await adRatingLine("ChIJabcdefghij", true)).toBe("★ 4.6 on Google (37 reviews)");
    expect(await adRatingLine("ChIJabcdefghij", false)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mask(fetchMock.mock.calls[0])).toBe("rating,userRatingCount");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ rating: 3.2, userRatingCount: 37 }))));
    expect(await adRatingLine("ChIJabcdefghij", true)).toBeNull();
  });

  it("joins an existing end-card line when it fits", () => {
    expect(withEndCardLine({ endCardLine: "We fix Honda" }, "★ 4.8 on Google (5 reviews)").endCardLine).toBe(
      "We fix Honda · ★ 4.8 on Google (5 reviews)",
    );
    expect(withEndCardLine({ endCardLine: "x".repeat(50) }, "★ 4.8 on Google (5 reviews)").endCardLine).toBe(
      "★ 4.8 on Google (5 reviews)",
    );
  });
});

describe("Places API calls", () => {
  it("refuse without a key", async () => {
    vi.stubEnv("GOOGLE_PLACES_API_KEY", "");
    await expect(searchPlaces("joe plumbing")).rejects.toThrow("places_not_configured");
  });

  it("search with a narrow field mask and map the details", async () => {
    vi.stubEnv("GOOGLE_PLACES_API_KEY", "k");
    const address = "1 Main St, Springfield, IL 62701, USA";
    const fetchMock = vi.fn(async (url: string) =>
      String(url).endsWith(":searchText")
        ? new Response(JSON.stringify({ places: [{ id: "ChIJabcdefghij", displayName: { text: "Joes" }, formattedAddress: address }] }))
        : new Response(
            JSON.stringify({
              id: "ChIJabcdefghij",
              displayName: { text: "Joes" },
              formattedAddress: address,
              nationalPhoneNumber: "(217) 555-0100",
              websiteUri: "https://joes.test",
              regularOpeningHours: { weekdayDescriptions: ["Monday: 8:00 AM - 5:00 PM", "Tuesday: Closed"] },
              primaryType: "plumber",
              rating: 4.9,
              userRatingCount: 88,
            }),
          ),
    );
    vi.stubGlobal("fetch", fetchMock);
    expect(await searchPlaces("joe plumbing springfield")).toEqual([{ placeId: "ChIJabcdefghij", name: "Joes", address }]);
    expect(mask(fetchMock.mock.calls[0])).toBe("places.id,places.displayName,places.formattedAddress");
    const d = await placeDetails("ChIJabcdefghij");
    expect(d).toMatchObject({ zip: "62701", city: "Springfield", phone: "(217) 555-0100", primaryType: "plumber", ratingEligible: true });
    expect(d!.hours).toBe("Monday: 8:00 AM - 5:00 PM; Tuesday: Closed");
    expect(mask(fetchMock.mock.calls[1])).toBe(DETAILS_FIELDS);
    expect(await placeDetails("bad id!")).toBeNull();
  });

  it("rate-limit each user", () => {
    resetPlacesLimits();
    for (let i = 0; i < 30; i++) expect(allowPlacesCall("u", 1000)).toBe(true);
    expect(allowPlacesCall("u", 1000)).toBe(false);
    expect(allowPlacesCall("v", 1000)).toBe(true);
  });
});

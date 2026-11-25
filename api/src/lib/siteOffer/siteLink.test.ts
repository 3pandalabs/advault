import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const status = vi.hoisted(() => ({ value: null as null | { siteState: string } }));
vi.mock("./index.js", () => ({ fetchSiteOfferStatus: async () => status.value }));

const { showableLandingUrl, siteLinkState, siteLinkLaunchError } = await import("./siteLink.js");
const URL = "https://wax.3pandasite.com";
const page = (code: number | null) =>
  vi.stubGlobal("fetch", async () => {
    if (code === null) throw new Error("down");
    return new Response("x", { status: code });
  });

beforeEach(() => {
  status.value = null;
});
afterEach(() => vi.unstubAllGlobals());

describe("siteLinkState", () => {
  it("leaves a link that isn't ours alone", async () => {
    page(null);
    expect(await siteLinkState("https://example.com")).toBe("live");
  });
  it.each(["unpublished", "paused"])("%s wins over the 200 hold page", async (s) => {
    page(200);
    status.value = { siteState: s };
    expect(await siteLinkState(URL)).toBe(s);
  });
  it.each(["live", "grace"])("%s is live once the page loads", async (s) => {
    status.value = { siteState: s };
    page(200);
    expect(await siteLinkState(URL)).toBe("live");
    page(503);
    expect(await siteLinkState(URL)).toBe("loading");
    page(null);
    expect(await siteLinkState(URL)).toBe("loading");
  });
  it("without an answer from SiteVault, only a 404 page means not found", async () => {
    page(404);
    expect(await siteLinkState(URL)).toBe("not_found");
    page(200);
    expect(await siteLinkState(URL)).toBe("unknown");
    page(null);
    expect(await siteLinkState(URL)).toBe("unknown");
  });
});

describe("siteLinkLaunchError", () => {
  it("refuses only what visitors can't see", () => {
    expect(siteLinkLaunchError("unpublished")).toBe("website_not_published");
    expect(siteLinkLaunchError("paused")).toBe("website_paused");
    expect(siteLinkLaunchError("not_found")).toBe("website_not_found");
    for (const s of ["live", "loading", "unknown"] as const) expect(siteLinkLaunchError(s)).toBeNull();
  });
});

describe("showableLandingUrl (end card, YouTube description)", () => {
  it("leaves off a SiteVault address that 404s", async () => {
    page(404);
    expect(await showableLandingUrl(URL)).toBeNull();
  });
  it.each(["unpublished", "paused"])("leaves off a site that is %s", async (s) => {
    page(200);
    status.value = { siteState: s };
    expect(await showableLandingUrl(URL)).toBeNull();
  });
  it("keeps a live site, one still loading, and any link during an outage", async () => {
    status.value = { siteState: "live" };
    page(200);
    expect(await showableLandingUrl(URL)).toBe(URL);
    page(404);
    expect(await showableLandingUrl(URL)).toBe(URL);
    status.value = null;
    page(null);
    expect(await showableLandingUrl(URL)).toBe(URL);
  });
  it("keeps other websites, and null stays null", async () => {
    page(404);
    expect(await showableLandingUrl("https://example.com")).toBe("https://example.com");
    expect(await showableLandingUrl(null)).toBeNull();
  });
});

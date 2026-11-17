import { describe, expect, it } from "vitest";
import { pickSiteVideo, siteVideoDue, wantsSiteVideo, SITE_VIDEO_MAX_ATTEMPTS, SITE_VIDEO_MAX_BYTES } from "./policy.js";

describe("wantsSiteVideo", () => {
  it("defaults to yes for a SiteVault site", () => {
    expect(wantsSiteVideo({ requested: undefined, sitevaultSlug: "joes", advaultMade: true })).toBe(true);
    expect(wantsSiteVideo({ requested: true, sitevaultSlug: "joes", advaultMade: true })).toBe(true);
  });
  it("respects an unticked box", () => {
    expect(wantsSiteVideo({ requested: false, sitevaultSlug: "joes", advaultMade: true })).toBe(false);
  });
  it("never for a website that isn't SiteVault", () => {
    expect(wantsSiteVideo({ requested: true, sitevaultSlug: null, advaultMade: true })).toBe(false);
  });
  it("never for a site built on SiteVault itself (its video route refuses those)", () => {
    expect(wantsSiteVideo({ requested: true, sitevaultSlug: "joes", advaultMade: false })).toBe(false);
  });
});

describe("siteVideoDue", () => {
  const base = { siteVideoWanted: true, siteVideoPushedAt: null, siteVideoAttempts: 0 };
  it("is due when wanted and not pushed", () => expect(siteVideoDue(base)).toBe(true));
  it("not when already pushed", () => expect(siteVideoDue({ ...base, siteVideoPushedAt: new Date() })).toBe(false));
  it("not when not wanted", () => expect(siteVideoDue({ ...base, siteVideoWanted: false })).toBe(false));
  it("stops after the last attempt", () =>
    expect(siteVideoDue({ ...base, siteVideoAttempts: SITE_VIDEO_MAX_ATTEMPTS })).toBe(false));
});

describe("pickSiteVideo", () => {
  const v = (aspectRatio: string, videoKey: string | null, sizeBytes = 1000) => ({ aspectRatio, videoKey, sizeBytes });
  it("prefers the newest widescreen cut", () => {
    expect(pickSiteVideo([v("9:16", "a"), v("16:9", "b"), v("16:9", "c")])?.videoKey).toBe("b");
  });
  it("falls back to vertical", () => expect(pickSiteVideo([v("9:16", "a")])?.videoKey).toBe("a"));
  it("skips missing and oversized files", () => {
    expect(pickSiteVideo([v("16:9", null), v("16:9", "big", SITE_VIDEO_MAX_BYTES + 1), v("9:16", "ok")])?.videoKey).toBe("ok");
    expect(pickSiteVideo([])).toBeNull();
  });
});

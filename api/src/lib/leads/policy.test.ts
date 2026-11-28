import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OWNER_EMAILS_PER_SITE_PER_HOUR,
  allowOwnerEmail,
  bookingWindow,
  campaignIdFromSource,
  cleanSource,
  formatBookingTime,
  leadInput,
  overlaps,
  resetOwnerEmailLimits,
  signLeadLink,
  verifyLeadLink,
} from "./policy.js";
import { displayName, ownerLeadMail } from "./templates.js";

const ID = "6a28661a-10b6-4563-b093-5285dc85b390";

beforeEach(() => {
  vi.stubEnv("JWT_SECRET", "test-jwt-secret-test-jwt-secret-0000");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("lead input", () => {
  const base = { slug: "joes", kind: "quote", name: "Sam", phone: "555", idempotencyKey: "k" };
  it("treats blank optional strings as absent and lowercases emails", () => {
    const v = leadInput.parse({ ...base, email: "", message: " ", ownerEmail: "A@B.test", advaultUserId: "" });
    expect(v.email).toBeUndefined();
    expect(v.message).toBeUndefined();
    expect(v.ownerEmail).toBe("a@b.test");
    expect(v.advaultUserId).toBeUndefined();
  });
  it("needs a booking for kind booking", () => {
    expect(leadInput.safeParse({ ...base, kind: "booking" }).success).toBe(false);
  });
});

describe("booking windows", () => {
  it("are half open: back to back is fine", () => {
    const a = bookingWindow({ start: "2026-12-01T10:00:00-05:00", durationMin: 60 });
    const b = bookingWindow({ start: "2026-12-01T11:00:00-05:00", durationMin: 30 });
    const c = bookingWindow({ start: "2026-12-01T10:59:00-05:00", durationMin: 30 });
    expect(overlaps(a, b)).toBe(false);
    expect(overlaps(a, c)).toBe(true);
  });
  it("format in the booking's own time zone", () => {
    expect(formatBookingTime(new Date("2026-12-06T19:30:00Z"), "America/New_York").replace(/ /g, " ")).toBe(
      "Sun, Dec 6, 2:30 PM",
    );
  });
});

describe("attribution", () => {
  it("keeps only a uuid utm_campaign", () => {
    expect(campaignIdFromSource(cleanSource({ utmCampaign: ID.toUpperCase() }))).toBe(ID);
    expect(campaignIdFromSource(cleanSource({ utmCampaign: "spring-sale" }))).toBeNull();
    expect(cleanSource({})).toBeNull();
  });
});

describe("signed links", () => {
  it("round trip, and refuse tampering, expiry, another key or no key", () => {
    const t = signLeadLink(ID, "confirm")!;
    expect(verifyLeadLink(t)).toEqual({ leadId: ID, action: "confirm" });
    expect(verifyLeadLink(t.replace(".c.", ".d."))).toBeNull();
    expect(verifyLeadLink(signLeadLink(ID, "decline", Date.now() - 15 * 86_400_000)!)).toBeNull();
    vi.stubEnv("JWT_SECRET", "another-secret-another-secret-0000");
    expect(verifyLeadLink(t)).toBeNull();
    vi.stubEnv("JWT_SECRET", "");
    expect(signLeadLink(ID, "confirm")).toBeNull();
  });
});

describe("owner email throttle", () => {
  it("caps emails per site per hour", () => {
    resetOwnerEmailLimits();
    for (let i = 0; i < OWNER_EMAILS_PER_SITE_PER_HOUR; i++) expect(allowOwnerEmail("s", 1000 + i)).toBe(true);
    expect(allowOwnerEmail("s", 2000)).toBe(false);
    expect(allowOwnerEmail("other", 2000)).toBe(true);
    expect(allowOwnerEmail("s", 1000 + 60 * 60_000 + 1)).toBe(true);
  });
});

describe("templates", () => {
  it("strip header-unsafe characters from display names", () => {
    expect(displayName('Joe "Best" <Plumbing>, Inc')).toBe("Joe Best Plumbing Inc");
  });
  it("escape what the customer typed", () => {
    const m = ownerLeadMail(
      "o@x.test",
      {
        id: ID,
        kind: "quote",
        name: "<b>Sam</b>",
        phone: "1",
        email: null,
        message: "<script>x</script>",
        bestTime: null,
        photoUrls: [],
        bookingService: null,
        bookingDurationMin: null,
        bookingStart: null,
        bookingTimezone: null,
        fromAd: false,
      },
      { inbox: "https://a.test/dashboard/leads", confirm: null, decline: null },
    );
    expect(m.html).not.toContain("<script>");
    expect(m.replyTo).toBeUndefined();
    expect(m.text).toContain("They left no email");
  });
});

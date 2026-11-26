import { afterEach, describe, expect, it, vi } from "vitest";
import { isFreshSignup, newUserAlertTo, newUserMail } from "./newUserAlert.js";

afterEach(() => vi.unstubAllEnvs());

describe("new user alert", () => {
  it("subject is '<App> New user' and the body names the account", () => {
    const m = newUserMail("ops@example.com", {
      app: "SiteVault",
      email: "owner@example.com",
      userId: "u1",
      businessName: "Joe's <Plumbing>",
      fromAd: true,
      at: new Date("2026-11-26T13:05:00Z"),
    });
    expect(m.subject).toBe("SiteVault New user");
    expect(m.to).toBe("ops@example.com");
    expect(m.text).toContain("Email: owner@example.com");
    expect(m.text).toContain("Came from: one of our ads");
    expect(m.text).toContain("2026-11-26 13:05 UTC");
    expect(m.html).toContain("Joe's &lt;Plumbing&gt;");
    expect(m.html).not.toContain("<Plumbing>");
  });
  it("goes to the org inbox by default, an override, or nowhere when off", () => {
    vi.stubEnv("NEW_USER_ALERT_EMAIL", "");
    expect(newUserAlertTo()).toBe("3pandas@3pandalabs.com");
    vi.stubEnv("NEW_USER_ALERT_EMAIL", "x@example.com");
    expect(newUserAlertTo()).toBe("x@example.com");
    vi.stubEnv("NEW_USER_ALERT_EMAIL", "OFF");
    expect(newUserAlertTo()).toBeNull();
  });
  it("an older SiteVault account being moved over is not a new sign-up", () => {
    const now = new Date("2026-11-26T12:00:00Z");
    expect(isFreshSignup(undefined, now)).toBe(true);
    expect(isFreshSignup("2026-11-26T11:00:00Z", now)).toBe(true);
    expect(isFreshSignup("2026-10-01T00:00:00Z", now)).toBe(false);
  });
});

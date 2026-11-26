import { describe, expect, it } from "vitest";
import { adReadyDecision, customerEmailSkip, makeAnchor, webOrigin, type MakeCreative } from "./policy.js";
import { adAccountReadyMail, adReadyMail, lowBudgetMail, welcomeMail } from "./templates.js";

const O = "https://advault.3pandalabs.com";

describe("customer email templates", () => {
  const all = [
    welcomeMail("a@example.com", { origin: O, name: "Maria" }),
    adAccountReadyMail("a@example.com", { origin: O, name: "Maria", campaign: { id: "c1", name: "Spring" } }),
    adAccountReadyMail("a@example.com", { origin: O }),
    adReadyMail("a@example.com", { origin: O, campaign: { id: "c1", name: "Spring", businessName: "Joe's" } }),
    lowBudgetMail("a@example.com", { origin: O, balance: "$8.50", daily: "$5", daysLeft: 1 }),
  ];

  it("come from advault@ as AdVault (never the reset sender), with a text part and the link in both parts", () => {
    for (const m of all) {
      expect(m.from).toBe("advault@3pandalabs.com");
      expect(m.fromName).toBe("AdVault");
      expect(m.to).toBe("a@example.com");
      expect(m.text.length).toBeGreaterThan(20);
      const link = m.text.match(/https:\/\/\S+/)![0];
      expect(m.html).toContain(link.replace(/&/g, "&amp;"));
    }
  });

  it("welcome links to making the first ad", () => {
    expect(all[0]!.subject).toBe("Welcome to AdVault");
    expect(all[0]!.text).toContain(`${O}/dashboard/campaigns/new`);
    expect(all[0]!.text.startsWith("Hi Maria,")).toBe(true);
  });

  it("ad account ready links to the campaign, else the dashboard", () => {
    expect(all[1]!.text).toContain(`Launch your ad: ${O}/dashboard/campaigns/c1`);
    expect(all[2]!.text).toContain(`Open your dashboard: ${O}/dashboard`);
    expect(all[2]!.text.startsWith("Hi,")).toBe(true);
  });

  it("ad ready names the campaign and links to it", () => {
    expect(all[3]!.subject).toBe("Your ad is ready: Spring");
    expect(all[3]!.text).toContain(`${O}/dashboard/campaigns/c1`);
  });

  it("low budget shows the real balance and days, links to the budget card or the Balance page", () => {
    const one = lowBudgetMail("a@example.com", {
      origin: O, balance: "$8.50", daily: "$5", daysLeft: 1, campaign: { id: "c9", name: "x" },
    });
    expect(one.text).toContain("$8.50 left. That's about 1 day at $5 a day.");
    expect(one.text).toContain(`${O}/dashboard/campaigns/c9#ad-budget`);
    expect(all[4]!.text).toContain(`${O}/dashboard/wallet`);
    const many = lowBudgetMail("a@example.com", { origin: O, balance: "$12", daily: "$5", daysLeft: 2 });
    expect(many.text).toContain("about 2 days at $5 a day");
  });

  it("escapes names in the HTML and keeps them on one line", () => {
    const m = adReadyMail("a@example.com", {
      origin: O,
      name: "<b>Eve</b>",
      campaign: { id: "c1", name: "Big\r\nSale <script>", businessName: `Joe's "Pipes" & Co` },
    });
    expect(m.subject).toBe("Your ad is ready: Big Sale <script>");
    expect(m.html).not.toContain("<script>");
    expect(m.html).not.toContain("<b>Eve</b>");
    expect(m.html).toContain("&lt;b&gt;Eve&lt;/b&gt;");
    expect(m.html).toContain("Joe&#39;s &quot;Pipes&quot; &amp; Co");
  });
});

describe("who gets customer emails", () => {
  const base = { email: "shop@example.com", role: "advertiser", deletedAt: null, testOwnerId: null };
  it("customers and internal accounts (plain advertisers) do", () => {
    expect(customerEmailSkip(base)).toBeNull();
    expect(customerEmailSkip({ ...base, email: "advault@3pandalabs.com" })).toBeNull();
  });
  it("deleted, test customers, .invalid addresses and admins don't", () => {
    expect(customerEmailSkip({ ...base, deletedAt: new Date() })).toBe("deleted");
    expect(customerEmailSkip({ ...base, testOwnerId: "admin-1" })).toBe("test_customer");
    expect(customerEmailSkip({ ...base, email: "t-1@test.advault.invalid" })).toBe("undeliverable");
    expect(customerEmailSkip({ ...base, role: "admin" })).toBe("admin");
    expect(customerEmailSkip({ ...base, email: "" })).toBe("no_email");
  });
  it("links default to the live site", () => {
    expect(webOrigin(undefined)).toBe(O);
    expect(webOrigin("http://localhost:3000/")).toBe("http://localhost:3000");
  });
});

describe("your ad is ready: once per make", () => {
  const t = (s: number) => new Date(1_800_000_000_000 + s * 1000);
  const cr = (id: string, at: number, p: Partial<MakeCreative> = {}): MakeCreative => ({
    id, createdAt: t(at), renderStatus: "ready", youtubeVideoId: `yt-${id}`, youtubeUploadStatus: "done",
    reviewStatus: null, readyEmailedAt: null, ...p,
  });

  it("waits for every format, then sends once on the anchor", () => {
    const wide = cr("b", 0);
    const tall = cr("a", 1, { youtubeVideoId: null, youtubeUploadStatus: "uploading" });
    expect(adReadyDecision([wide, tall])).toEqual({ send: false });
    expect(adReadyDecision([wide, { ...tall, youtubeVideoId: "yt", youtubeUploadStatus: "done" }])).toEqual({
      send: true,
      anchorId: "b",
    });
    expect(adReadyDecision([{ ...wide, readyEmailedAt: t(5) }, { ...tall, youtubeVideoId: "yt" }])).toEqual({ send: false });
  });

  it("rendered but not on YouTube is not Ready", () => {
    expect(adReadyDecision([cr("a", 0, { youtubeVideoId: null, youtubeUploadStatus: "pending" })])).toEqual({ send: false });
  });

  it("a failed format doesn't block the other; all failed sends nothing", () => {
    expect(adReadyDecision([cr("a", 0), cr("b", 1, { renderStatus: "failed", youtubeVideoId: null })])).toEqual({
      send: true,
      anchorId: "a",
    });
    expect(
      adReadyDecision([
        cr("a", 0, { renderStatus: "failed", youtubeVideoId: null }),
        cr("b", 1, { youtubeVideoId: null, youtubeUploadStatus: "failed" }),
      ]),
    ).toEqual({ send: false });
  });

  it("anchor is the first creative (createdAt, then id)", () => {
    expect(makeAnchor([cr("z", 0), cr("a", 0), cr("b", -1)])!.id).toBe("b");
    expect(makeAnchor([cr("z", 0), cr("a", 0)])!.id).toBe("a");
    expect(makeAnchor([])).toBeNull();
  });
});

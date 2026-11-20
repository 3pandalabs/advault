import { describe, expect, it } from "vitest";
import { claimBlock, claimFlags, claimReviews } from "./claimRules.js";
import { approveAll, attestationRefusal, firstIp, nextCompliance, reviewReasons, takenDownRefusal, termsRefusal } from "./policy.js";
import { ATTESTATION_VERSION, TERMS_VERSION } from "./texts.js";

describe("claim rules: severities", () => {
  it("existing severities are unchanged", () => {
    expect(claimBlock("realEstate", "Adults only building")?.id).toBe("housing_exclusion");
    for (const t of ["#1 plumber", "the cheapest in town", "money-back promise"]) {
      expect(claimFlags("plumbing", t).every((f) => f.level === "warn"), t).toBe(true);
    }
    expect(claimFlags("dentistry", "Painless cleanings")[0]).toMatchObject({ id: "health_painless", level: "warn" });
  });

  it.each([
    ["This tea cures diabetes", "review_health_cure"],
    ["Miracle results in a week", "review_health_cure"],
    ["Lose 20 lbs before summer", "review_health_cure"],
    ["We treat arthritis naturally", "review_health_cure"],
    ["Invest in Bitcoin with us", "review_finance"],
    ["Guaranteed returns of 12%", "review_finance"],
    ["Payday loans, no credit check", "review_finance"],
    ["Guaranteed results or your money back", "review_guaranteed_results"],
  ])("REVIEW: %s", (text, id) => {
    expect(claimReviews(null, text).map((f) => f.id)).toContain(id);
  });

  it("ordinary copy raises no review", () => {
    for (const t of ["$49 drain cleaning this month", "Fresh pizza, order online", "Heated seats installed", "Healthy smiles for the family"]) {
      expect(claimReviews("plumbing", t), t).toEqual([]);
    }
  });
});

describe("compliance state", () => {
  const found = reviewReasons(null, [{ field: "offer", text: "This cures back pain" }]);

  it("review phrases -> needs_review; approval sticks for the same phrase; a new one re-flags", () => {
    const first = nextCompliance({ status: "ok", reasons: null }, found);
    expect(first.status).toBe("needs_review");
    const approved = { status: "ok" as const, reasons: approveAll(first.reasons) };
    expect(nextCompliance(approved, found).status).toBe("ok");
    const more = reviewReasons(null, [{ field: "offer", text: "This cures back pain. Pay in bitcoin." }]);
    expect(nextCompliance(approved, more).status).toBe("needs_review");
    expect(nextCompliance(approved, []).status).toBe("ok");
  });

  it("taken_down never changes by re-evaluation", () => {
    expect(nextCompliance({ status: "taken_down", reasons: null }, []).status).toBe("taken_down");
  });

  it("refusals", () => {
    expect(attestationRefusal({ accuracy: true, media: true, version: ATTESTATION_VERSION })).toBeNull();
    expect(attestationRefusal({ accuracy: true, media: true })?.body.error).toBe("attestation_required");
    expect(attestationRefusal(null)?.status).toBe(400);
    expect(termsRefusal(TERMS_VERSION)).toBeNull();
    expect(termsRefusal("old")?.status).toBe(409);
    expect(takenDownRefusal({ complianceStatus: "taken_down" })?.body.error).toBe("ad_taken_down");
    expect(firstIp("203.0.113.7, 10.0.0.1")).toBe("203.0.113.7");
    expect(firstIp(undefined)).toBeNull();
  });
});

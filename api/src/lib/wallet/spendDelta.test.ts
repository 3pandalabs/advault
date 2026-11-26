import { describe, expect, it } from "vitest";
import { ledgerByDay, spendCorrection, spendRefDate } from "./spendDelta.js";

const C = "11111111-2222-3333-4444-555555555555";
const D = "2026-11-25";

describe("spend sync records the difference", () => {
  it("first reading of a day uses the old key", () => {
    expect(spendCorrection({ campaignId: C, date: D, reportedMinor: 50, ledger: undefined })).toEqual({
      amountMinor: -50,
      externalRef: `gads:${C}:${D}`,
      type: "spend",
    });
  });
  it("a later, higher reading debits only the rest (the 2026-11-25 bug)", () => {
    expect(spendCorrection({ campaignId: C, date: D, reportedMinor: 300, ledger: { sumMinor: -50, rows: 1 } })).toEqual({
      amountMinor: -250,
      externalRef: `gads:${C}:${D}:1`,
      type: "spend",
    });
  });
  it("the same reading again changes nothing", () => {
    expect(spendCorrection({ campaignId: C, date: D, reportedMinor: 300, ledger: { sumMinor: -300, rows: 2 } })).toBeNull();
  });
  it("Google lowering a day credits the difference back", () => {
    expect(spendCorrection({ campaignId: C, date: D, reportedMinor: 280, ledger: { sumMinor: -300, rows: 2 } })).toEqual({
      amountMinor: 20,
      externalRef: `gads:${C}:${D}:2`,
      type: "adjustment",
    });
  });
  it("zero spend on a day writes nothing", () => {
    expect(spendCorrection({ campaignId: C, date: D, reportedMinor: 0, ledger: undefined })).toBeNull();
  });
  it("groups old and new keys by day, ignoring other campaigns and refs", () => {
    const m = ledgerByDay(
      [
        { externalRef: `gads:${C}:${D}`, amountMinor: -50 },
        { externalRef: `gads:${C}:${D}:1`, amountMinor: -250 },
        { externalRef: `gads:${C}:2026-11-24`, amountMinor: -70 },
        { externalRef: `gads:99999999-2222-3333-4444-555555555555:${D}`, amountMinor: -999 },
        { externalRef: "pi_123", amountMinor: 5000 },
        { externalRef: null, amountMinor: -1 },
      ],
      C,
    );
    expect(m.get(D)).toEqual({ sumMinor: -300, rows: 2 });
    expect(m.get("2026-11-24")).toEqual({ sumMinor: -70, rows: 1 });
    expect(m.size).toBe(2);
    expect(spendRefDate(`gads:${C}:${D}:junk`, C)).toBeNull();
  });
});

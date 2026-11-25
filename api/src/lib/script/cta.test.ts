import { describe, expect, it } from "vitest";
import { answerableCallToAction, DEFAULT_CALL_TO_ACTION } from "./cta.js";

describe("answerableCallToAction", () => {
  it.each(["Call now", "CALL NOW", " call us today ", "Text us", "Phone today", "Give us a call", "Questions? Call us"])(
    "%s has no number to call",
    (s) => expect(answerableCallToAction(s)).toBe(DEFAULT_CALL_TO_ACTION),
  );
  it.each(["Call 201-555-0123", "Text (201) 555 0123", "Book a call", "Get a free quote", "Order now", "Call-out from $49"])(
    "%s is left alone",
    (s) => expect(answerableCallToAction(s)).toBe(s),
  );
  it("the default is itself answerable and fits", () => {
    expect(answerableCallToAction(DEFAULT_CALL_TO_ACTION)).toBe(DEFAULT_CALL_TO_ACTION);
    expect(DEFAULT_CALL_TO_ACTION.length).toBeLessThanOrEqual(40);
  });
});

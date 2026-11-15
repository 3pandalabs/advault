import { afterEach, describe, expect, it } from "vitest";
import { vertexOmniConfigured, vertexOmniFirst } from "./omni.js";

const key = Buffer.from(
  JSON.stringify({ client_email: "a@b.iam.gserviceaccount.com", private_key: "x", project_id: "p" }),
).toString("base64");

describe("vertex omni switch", () => {
  afterEach(() => {
    delete process.env.GOOGLE_SA_KEY_B64;
    delete process.env.OMNI_PROVIDERS;
  });

  it("leads by default once a key is present", () => {
    expect(vertexOmniFirst()).toBe(false);
    process.env.GOOGLE_SA_KEY_B64 = key;
    expect(vertexOmniFirst()).toBe(true);
  });

  it("goes first only when listed first AND a key is present", () => {
    process.env.OMNI_PROVIDERS = "vertex,fal";
    expect(vertexOmniFirst()).toBe(false);
    process.env.GOOGLE_SA_KEY_B64 = key;
    expect(vertexOmniFirst()).toBe(true);
    process.env.OMNI_PROVIDERS = "fal,vertex";
    expect(vertexOmniFirst()).toBe(false);
  });

  it("treats a malformed key as not configured", () => {
    process.env.GOOGLE_SA_KEY_B64 = Buffer.from("{not json").toString("base64");
    expect(vertexOmniConfigured()).toBe(false);
  });
});

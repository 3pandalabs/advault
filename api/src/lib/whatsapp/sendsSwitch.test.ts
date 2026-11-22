import { afterEach, describe, expect, it, vi } from "vitest";

// The master send switch: credentials alone must never make anything go out.
async function load(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return import("./index.js");
}

const CREDS = { WHATSAPP_TOKEN: "t", WHATSAPP_PHONE_NUMBER_ID: "1", WHATSAPP_APP_SECRET: "s" };
const KEYS = [...Object.keys(CREDS), "WHATSAPP_SENDS", "OFFER_SWAP_WHATSAPP"];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

describe("WHATSAPP_SENDS", () => {
  it("credentials without WHATSAPP_SENDS=on: configured, but nothing sends", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const wa = await load({ ...CREDS, WHATSAPP_SENDS: undefined, OFFER_SWAP_WHATSAPP: "on" });
    expect(wa.isWhatsAppConfigured()).toBe(true);
    expect(wa.whatsAppSendsEnabled()).toBe(false);
    expect(wa.offerSwapWhatsAppEnabled()).toBe(false);
    await expect(wa.sendText({ to: "15550000000", body: "hi" })).rejects.toThrow("whatsapp_not_configured");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("WHATSAPP_SENDS=on enables sends; the offer-change loop still needs its own flag", async () => {
    const wa = await load({ ...CREDS, WHATSAPP_SENDS: "on", OFFER_SWAP_WHATSAPP: undefined });
    expect(wa.whatsAppSendsEnabled()).toBe(true);
    expect(wa.offerSwapWhatsAppEnabled()).toBe(false);
  });
});

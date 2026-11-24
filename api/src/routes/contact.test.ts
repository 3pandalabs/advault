import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// clientIp's module opens the database; only the IP is needed here.
vi.mock("../lib/compliance/index.js", () => ({
  clientIp: (req: { headers: Record<string, string> }) => req.headers["cf-connecting-ip"] ?? null,
}));
const { contactRoutes, resetContactLimits, CONTACT_PER_HOUR, CONTACT_PER_IP_PER_HOUR } = await import("./contact.js");

const good = { name: "Sam Lee", email: "sam@example.com", subject: "My ad", message: "Hello <b>there</b>" };
const fetchMock = vi.fn();

async function post(payload: object, ip = "1.1.1.1", userId?: string) {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorateRequest("userId", undefined);
  app.addHook("onRequest", async (req) => {
    req.userId = userId;
  });
  await app.register(contactRoutes);
  return app.inject({ method: "POST", url: "/contact", payload, headers: { "cf-connecting-ip": ip } });
}

beforeEach(() => {
  resetContactLimits();
  vi.stubEnv("MAILER_URL", "https://mailer.test");
  vi.stubEnv("MAILER_TOKEN", "t");
  vi.stubEnv("CONTACT_EMAIL", "");
  fetchMock.mockReset().mockImplementation(async () => new Response(JSON.stringify({ delivered: 1 })));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const sent = () => JSON.parse(fetchMock.mock.calls[0]![1].body).messages[0];

describe("POST /contact", () => {
  it("emails us with the sender as Reply-To, HTML escaped", async () => {
    expect((await post(good)).statusCode).toBe(204);
    expect(sent()).toMatchObject({ to: "advault@3pandalabs.com", from: "advault@3pandalabs.com", replyTo: "sam@example.com", subject: "AdVault contact: My ad" });
    expect(sent().html).toContain("Hello &lt;b&gt;there&lt;/b&gt;");
    expect(sent().text).toContain("(not signed in)");
  });

  it("says which account when signed in, and keeps the subject on one line", async () => {
    await post({ ...good, subject: "Hi\r\nBcc: x@example.com" }, "1.1.1.1", "user-1");
    expect(sent().text).toContain("(signed in as user user-1)");
    expect(sent().subject).toBe("AdVault contact: Hi Bcc: x@example.com");
  });

  it("drops bots that fill the honeypot", async () => {
    expect((await post({ ...good, website: "http://spam" })).statusCode).toBe(204);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses missing or bad fields", async () => {
    for (const bad of [{ name: " " }, { email: "nope" }, { subject: "" }, { message: "" }, { message: "x".repeat(4001) }]) {
      expect((await post({ ...good, ...bad })).statusCode).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("limits one IP, then everyone", async () => {
    for (let i = 0; i < CONTACT_PER_IP_PER_HOUR; i++) expect((await post(good)).statusCode).toBe(204);
    expect((await post(good)).statusCode).toBe(429);
    for (let i = CONTACT_PER_IP_PER_HOUR; i < CONTACT_PER_HOUR; i++) expect((await post(good, `2.2.2.${i}`)).statusCode).toBe(204);
    expect((await post(good, "3.3.3.3")).statusCode).toBe(429);
  });

  it("never says sent when the email did not go out", async () => {
    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ delivered: 0, failed: 1 })));
    expect((await post(good)).statusCode).toBe(503);
    fetchMock.mockImplementationOnce(async () => new Response("no", { status: 500 }));
    expect((await post(good)).statusCode).toBe(503);
    vi.stubEnv("MAILER_TOKEN", "");
    expect((await post(good)).statusCode).toBe(503);
  });
});

// Auth runs before validation: a malformed call with no credentials must get
// 401, never a 400 that describes the schema (QA 2026-11-23). Registers every
// route plugin index.ts does and calls every route that isn't listed as public
// below, so a new route with its guard in preHandler (or the handler) fails here.
import Fastify, { type FastifyInstance, type HTTPMethods } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  // env.ts refuses to load without these; nothing here connects to them.
  const dummy: Record<string, string> = {
    DATABASE_URL: "postgres://unused@localhost/unused",
    JWT_SECRET: "test-jwt-secret-test-jwt-secret-0000",
    R2_ACCOUNT_ID: "x",
    R2_ACCESS_KEY_ID: "x",
    R2_SECRET_ACCESS_KEY: "x",
    R2_BUCKET: "x",
    R2_ENDPOINT: "https://r2.invalid",
    TOKEN_ENCRYPTION_KEY: "0".repeat(64),
    METRICS_TOKEN: "metrics-token-for-tests",
    ADMIN_ANALYTICS_TOKEN: "analytics-token-for-tests",
    SITEVAULT_INTERNAL_TOKEN: "internal-token-for-tests",
  };
  for (const [k, v] of Object.entries(dummy)) process.env[k] ??= v;
});

// No route here may reach the database; anything that does gets a 500, not a 401.
vi.mock("../db/index.js", () => ({ db: {} }));

/** Routes that legitimately answer without a session or a bearer token. */
const PUBLIC = new Set<string>([
  "POST /auth/register",
  "POST /auth/login",
  "POST /auth/password-reset/request",
  "POST /auth/password-reset/confirm",
  "POST /auth/refresh",
  "POST /auth/logout",
  // The one-time token is in the body.
  "POST /auth/handoff",
  "GET /pricing",
  "GET /pricing/estimate",
  "GET /plans",
  "GET /add-ons",
  // Signed by the provider.
  "POST /webhooks/payments/:provider",
  "POST /webhooks/subscriptions/:provider",
  "POST /webhooks/purchases/:provider",
  "POST /webhooks/stripe",
  "GET /webhooks/whatsapp",
  "POST /webhooks/whatsapp",
  // The "Report this ad" page and the ad-click counter.
  "GET /reports/ad/:publicId",
  "POST /reports",
  "POST /track/visit",
]);

type Route = { method: HTTPMethods; url: string };
const routes: Route[] = [];
let app: FastifyInstance;

beforeAll(async () => {
  const { authPlugin } = await import("../auth/plugin.js");
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.addHook("onRoute", (r) => {
    for (const method of [r.method].flat()) if (method !== "HEAD") routes.push({ method: method as HTTPMethods, url: r.url });
  });
  await app.register(authPlugin);
  // The plugins index.ts registers, read from it so none can be forgotten.
  const index = readFileSync(join(__dirname, "../index.ts"), "utf8");
  const imports = [...index.matchAll(/import \{ (\w+Routes) \} from "\.\/routes\/(\w+)\.js"/g)];
  expect(imports.length).toBe([...index.matchAll(/app\.register\(\w+Routes/g)].length);
  for (const [, name, file] of imports) {
    const mod = (await import(/* @vite-ignore */ `./${file}.ts`)) as Record<string, (a: FastifyInstance, o: { db: never }) => Promise<void>>;
    await app.register(mod[name!]!, { db: {} as never });
  }
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
});

const BAD_CALLS = [
  { name: "wrong types", payload: JSON.stringify([1]) },
  { name: "empty object", payload: "{}" },
  { name: "broken JSON", payload: "{" },
];

async function call(r: Route, payload: string, headers: Record<string, string> = {}) {
  const hasBody = !["GET", "DELETE"].includes(r.method as string);
  return app.inject({
    method: r.method as "GET",
    // Not a UUID, and query values no schema accepts.
    url: `${r.url.replace(/:\w+/g, "not-a-uuid")}?since=x&until=x&days=x&limit=x&status=x&range=x&q[]=x`,
    headers: hasBody ? { "content-type": "application/json", ...headers } : headers,
    ...(hasBody ? { payload } : {}),
  });
}

describe("auth before validation", () => {
  it("every non-public route answers a malformed call without credentials with 401", async () => {
    const guarded = routes.filter((r) => !PUBLIC.has(`${r.method} ${r.url}`));
    expect(guarded.filter((r) => /^\/(admin|internal)\//.test(r.url)).length).toBeGreaterThanOrEqual(26);
    const wrong: string[] = [];
    for (const r of guarded) {
      for (const bad of BAD_CALLS) {
        for (const headers of [{}, { authorization: "Bearer nope" }]) {
          const res = await call(r, bad.payload, headers as Record<string, string>);
          if (res.statusCode !== 401) wrong.push(`${r.method} ${r.url} (${bad.name}): ${res.statusCode}`);
        }
      }
    }
    expect([...new Set(wrong)]).toEqual([]);
  }, 60_000);

  it("the public list names only routes that exist, and no admin or internal one", () => {
    const known = new Set(routes.map((r) => `${r.method} ${r.url}`));
    expect([...PUBLIC].filter((p) => !known.has(p) || / \/(admin|internal)\//.test(p))).toEqual([]);
  });

  it("a signed-in customer's malformed admin call gets 403, not schema details", async () => {
    const { signAccessToken } = await import("../auth/jwt.js");
    const token = signAccessToken({ sub: "00000000-0000-4000-8000-000000000001", role: "advertiser" });
    // adminUsers' guard reads the role from the database, so it isn't covered here.
    const urls = ["/admin/cashflow", "/admin/wallet/credit", "/admin/campaigns/:campaignId/takedown", "/admin/video-reviews/:creativeId"];
    for (const r of routes.filter((x) => urls.includes(x.url))) {
      const res = await call(r, "{}", { authorization: `Bearer ${token}` });
      expect([r.url, res.statusCode]).toEqual([r.url, 403]);
    }
  });

  it("valid credentials still get the 400 for a malformed call", async () => {
    const analytics = { authorization: "Bearer analytics-token-for-tests" };
    const cashflow = await call({ method: "GET", url: "/admin/cashflow" }, "", analytics);
    expect(cashflow.statusCode).toBe(400);
    const internal = { authorization: "Bearer internal-token-for-tests" };
    for (const r of routes.filter((x) => x.url.startsWith("/internal/sitevault/"))) {
      expect([r.url, (await call(r, "{}", internal)).statusCode]).toEqual([r.url, 400]);
    }
  });
});

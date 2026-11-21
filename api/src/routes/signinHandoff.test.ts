// One-tap sign-in (lib/signinHandoff, routes/signinHandoff.ts) through
// Fastify against PGlite with every migration applied: the real JWT auth
// plugin, the real session issuing, and the nonce table.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import Fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "../db/schema.js";
import { mintSigninToken, safeNextPath, signSigninToken, verifySigninToken, type SigninToken } from "../lib/signinHandoff/index.js";
import { signCreateHandoff, signEditorHandoff } from "../lib/sitevault/editorHandoff.js";

const SECRET = "test-internal-token";

const holder = vi.hoisted(() => {
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
  };
  for (const [k, v] of Object.entries(dummy)) process.env[k] ??= v;
  return { db: null as unknown };
});

vi.mock("../db/index.js", () => ({
  get db() {
    return holder.db;
  },
}));

let app: FastifyInstance;
let pg: PGlite;
let sign: (p: { sub: string; role: "admin" | "advertiser" }) => string;
let verifyAccess: (t: string) => { sub: string; role: string };
let customer: string;
let admin: string;
let deleted: string;
let testCustomer: string;

async function newUser(email: string, role: "admin" | "advertiser" = "advertiser", extra = ""): Promise<string> {
  const r = await pg.query<{ id: string }>(`insert into users (email, password_hash, role) values ($1, 'x', $2) returning id`, [email, role]);
  const id = r.rows[0]!.id;
  if (extra) await pg.query(`update users set ${extra} where id = $1`, [id]);
  return id;
}

beforeAll(async () => {
  process.env.SITEVAULT_INTERNAL_TOKEN = SECRET;
  pg = new PGlite();
  const dir = join(__dirname, "../../drizzle");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    await pg.exec(readFileSync(join(dir, f), "utf8").replaceAll("--> statement-breakpoint", ""));
  }
  // 0044 is idempotent (migrations run at every container start).
  await pg.exec(readFileSync(join(dir, "0044_signin_handoff_nonces.sql"), "utf8").replaceAll("--> statement-breakpoint", ""));
  holder.db = drizzle(pg, { schema });
  customer = await newUser("shop@x.test");
  admin = await newUser("boss@x.test", "admin");
  deleted = await newUser("gone@x.test", "advertiser", "deleted_at = now()");
  testCustomer = await newUser("tc-1@test-customer.invalid", "advertiser", `test_owner_id = '${admin}'`);

  const jwt = await import("../auth/jwt.js");
  sign = jwt.signAccessToken;
  verifyAccess = jwt.verifyAccessToken;
  const { authPlugin } = await import("../auth/plugin.js");
  const { authRoutes } = await import("./auth.js");
  const { signinHandoffRoutes } = await import("./signinHandoff.js");
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(authPlugin);
  await app.register(authRoutes);
  await app.register(signinHandoffRoutes);
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  delete process.env.SITEVAULT_INTERNAL_TOKEN;
});

const exchange = (token: string) => app.inject({ method: "POST", url: "/auth/handoff", payload: { token } });
const fromSitevault = (uid: string, email: string, nowMs = Date.now()) => mintSigninToken(SECRET, "signin-advault", { uid, email }, nowMs);

describe("POST /auth/handoff (SiteVault -> AdVault)", () => {
  it("signs a linked account in with the normal session: the refresh token works", async () => {
    const res = await exchange(fromSitevault(customer, "Shop@X.test"));
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const { accessToken, refreshToken } = res.json() as { accessToken: string; refreshToken: string };
    expect(verifyAccess(accessToken)).toMatchObject({ sub: customer, role: "advertiser" });
    const refreshed = await app.inject({ method: "POST", url: "/auth/refresh", payload: { refreshToken } });
    expect(refreshed.statusCode).toBe(200);
    const me = await app.inject({ method: "GET", url: "/auth/me", headers: { authorization: `Bearer ${accessToken}` } });
    expect(me.json()).toMatchObject({ id: customer, email: "shop@x.test" });
  });

  it("works once: the second use is refused", async () => {
    const token = fromSitevault(customer, "shop@x.test");
    expect((await exchange(token)).statusCode).toBe(200);
    const again = await exchange(token);
    expect(again.statusCode).toBe(401);
    expect(again.json()).toEqual({ error: "handoff_refused" });
  });

  it("refuses an expired token, a too-long life and one from the future", async () => {
    expect((await exchange(fromSitevault(customer, "shop@x.test", Date.now() - 61_000))).statusCode).toBe(401);
    const iat = Math.floor(Date.now() / 1000);
    const base: SigninToken = { v: 1, purpose: "signin-advault", uid: customer, email: "shop@x.test", iat, exp: iat + 600, nonce: "n".repeat(24) };
    expect((await exchange(signSigninToken(SECRET, base))).statusCode).toBe(401);
    expect((await exchange(signSigninToken(SECRET, { ...base, nonce: "f".repeat(24), iat: iat + 120, exp: iat + 150 }))).statusCode).toBe(401);
  });

  it("refuses the other direction's token and the editor/create tokens (own prefix + purpose)", async () => {
    expect((await exchange(mintSigninToken(SECRET, "signin-sitevault", { uid: customer, email: "shop@x.test" }))).statusCode).toBe(401);
    const iat = Math.floor(Date.now() / 1000);
    const editor = signEditorHandoff(SECRET, { v: 1, uid: customer, email: "shop@x.test", slug: "shop", iat, exp: iat + 60, jti: "j".repeat(24) });
    expect((await exchange(editor)).statusCode).toBe(401);
    const create = signCreateHandoff(SECRET, {
      v: 1,
      purpose: "create",
      uid: customer,
      email: "shop@x.test",
      campaignId: customer,
      draft: "d".repeat(24),
      pay: false,
      iat,
      exp: iat + 60,
      jti: "k".repeat(24),
    });
    expect((await exchange(create)).statusCode).toBe(401);
    // A payload that names the right purpose but is MACed under the editor prefix.
    const forged = signEditorHandoff(SECRET, { purpose: "signin-advault", uid: customer, email: "shop@x.test", iat, exp: iat + 60, nonce: "m".repeat(24), v: 1 } as never);
    expect((await exchange(forged)).statusCode).toBe(401);
  });

  it("refuses a tampered payload or MAC and another secret", async () => {
    const token = fromSitevault(customer, "shop@x.test");
    const [payload, sig] = token.split(".") as [string, string];
    const other = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), uid: admin })).toString("base64url");
    expect((await exchange(`${other}.${sig}`)).statusCode).toBe(401);
    expect((await exchange(`${payload}.${sig.slice(0, -2)}${sig.endsWith("AA") ? "BB" : "AA"}`)).statusCode).toBe(401);
    expect((await exchange(mintSigninToken("another-secret", "signin-advault", { uid: customer, email: "shop@x.test" }))).statusCode).toBe(401);
    expect((await exchange("not-a-token")).statusCode).toBe(401);
    // The untouched token still works (nothing above used it up).
    expect((await exchange(token)).statusCode).toBe(200);
  });

  it("refuses a deleted or unknown user", async () => {
    expect((await exchange(fromSitevault(deleted, "gone@x.test"))).statusCode).toBe(401);
    expect((await exchange(fromSitevault("00000000-0000-4000-8000-000000000000", "shop@x.test"))).statusCode).toBe(401);
  });

  it("refuses when the email no longer matches, or is missing", async () => {
    expect((await exchange(fromSitevault(customer, "someone-else@x.test"))).statusCode).toBe(401);
    expect((await exchange(fromSitevault(customer, ""))).statusCode).toBe(401);
  });

  it("refuses admins (they sign in by hand) and test customers", async () => {
    expect((await exchange(fromSitevault(admin, "boss@x.test"))).statusCode).toBe(401);
    expect((await exchange(fromSitevault(testCustomer, "tc-1@test-customer.invalid"))).statusCode).toBe(401);
  });

  it("refuses everything while SITEVAULT_INTERNAL_TOKEN is unset", async () => {
    const token = fromSitevault(customer, "shop@x.test");
    delete process.env.SITEVAULT_INTERNAL_TOKEN;
    try {
      expect((await exchange(token)).statusCode).toBe(401);
    } finally {
      process.env.SITEVAULT_INTERNAL_TOKEN = SECRET;
    }
  });
});

describe("POST /auth/sitevault-handoff (AdVault -> SiteVault)", () => {
  const mint = (uid: string, role: "admin" | "advertiser", to?: string) =>
    app.inject({ method: "POST", url: "/auth/sitevault-handoff", headers: { authorization: `Bearer ${sign({ sub: uid, role })}` }, payload: to === undefined ? {} : { to } });

  function tokenFrom(url: string) {
    const u = new URL(url);
    expect(`${u.origin}${u.pathname}`).toBe("https://sitevault.3pandalabs.com/auth/handoff");
    return { t: u.searchParams.get("t")!, to: u.searchParams.get("to") };
  }

  it("needs a session", async () => {
    expect((await app.inject({ method: "POST", url: "/auth/sitevault-handoff", payload: {} })).statusCode).toBe(401);
  });

  it("mints a 60 s signin-sitevault token for the signed-in user, never cached", async () => {
    const res = await mint(customer, "advertiser", "/edit/shop");
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const { t, to } = tokenFrom((res.json() as { url: string }).url);
    expect(to).toBe("/edit/shop");
    const checked = verifySigninToken(SECRET, t, "signin-sitevault");
    expect(checked.ok && checked.token).toMatchObject({ uid: customer, email: "shop@x.test", purpose: "signin-sitevault" });
    if (checked.ok) expect(checked.token.exp - checked.token.iat).toBe(60);
    // ...and it is useless here.
    expect((await exchange(t)).statusCode).toBe(401);
  });

  it("sends a test customer by id only (no *.invalid email)", async () => {
    const { t } = tokenFrom(((await mint(testCustomer, "advertiser")).json() as { url: string }).url);
    const checked = verifySigninToken(SECRET, t, "signin-sitevault");
    expect(checked.ok && checked.token.email).toBe("");
  });

  it("defaults and sanitises `to` (no open redirect)", async () => {
    for (const bad of ["https://evil.test/x", "//evil.test", "/\\evil.test", "javascript:alert(1)", "evil", "/a\nb"]) {
      expect(tokenFrom(((await mint(customer, "advertiser", bad)).json() as { url: string }).url).to).toBe("/account");
    }
    expect(tokenFrom(((await mint(customer, "advertiser")).json() as { url: string }).url).to).toBe("/account");
  });

  it("gives admins (real role) and deleted accounts no link", async () => {
    expect((await mint(admin, "admin")).json()).toEqual({ url: null });
    expect((await mint(admin, "advertiser")).json()).toEqual({ url: null });
    expect((await mint(deleted, "advertiser")).json()).toEqual({ url: null });
  });
});

describe("safeNextPath", () => {
  it("keeps relative same-origin paths and rejects everything else", () => {
    expect(safeNextPath("/dashboard/campaigns/new?x=1#y", "/d")).toBe("/dashboard/campaigns/new?x=1#y");
    for (const bad of [undefined, "", "dashboard", "//evil.test", "/\\evil", "https://evil.test", "\t/x", "/x\r", "/a\nb"]) {
      expect(safeNextPath(bad, "/d")).toBe("/d");
    }
    expect(safeNextPath("//evil.test", "/d")).toBe("/d");
    expect(safeNextPath("/" + "a".repeat(600), "/d")).toBe("/d");
  });
});

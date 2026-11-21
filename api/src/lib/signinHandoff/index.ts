// One-tap sign-in between SiteVault and AdVault (2026-11-20). Both apps share
// ONE account store (this API's users table, CLAUDE.md "One 3PandaLabs
// account"), so a person signed in on one app can follow a link to the other
// and arrive signed in to the same account, with no password prompt.
//
//   token   = <payload>.<sig>
//   payload = base64url(JSON { v: 1, purpose, uid, email, iat, exp, nonce })
//   sig     = base64url(HMAC-SHA256(SITEVAULT_INTERNAL_TOKEN, "3pl-signin-v1." + payload))
//
//   purpose "signin-advault"    minted by SiteVault (GET /go/advault), checked
//                               here by POST /auth/handoff
//   purpose "signin-sitevault"  minted here (POST /auth/sitevault-handoff),
//                               checked by SiteVault GET /auth/handoff
//
// Same shared secret as the internal API and the editor/create handoffs, but
// its own MAC prefix AND an explicit purpose, so an editor token
// ("sv-embed-v1.") or a create token ("sv-embed-create-v1.") can never sign
// anybody in, and a token minted for one direction can't be replayed in the
// other. 60 s life, single use (here: signin_handoff_nonces; SiteVault: KV).
// Admin accounts are refused on both sides: admins sign in by hand. Tokens
// are never logged, and no password or long-lived secret is ever in a URL.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { eq, lt, sql } from "drizzle-orm";
import { signinHandoffNonces } from "../../db/schema.js";
import type { Db } from "../sharedAccount/index.js";

export const SIGNIN_PREFIX = "3pl-signin-v1.";
export const SIGNIN_TTL_SECONDS = 60;
/** Small allowance for clock drift between Cloudflare and the AdVault box. */
export const SIGNIN_CLOCK_SKEW_SECONDS = 5;

export type SigninPurpose = "signin-advault" | "signin-sitevault";

export type SigninToken = {
  v: 1;
  purpose: SigninPurpose;
  uid: string;
  /** The account's email; "" for an AdVault test customer (no real address). */
  email: string;
  iat: number;
  exp: number;
  nonce: string;
};

export type SigninCheck =
  | { ok: true; token: SigninToken }
  | { ok: false; error: "not_configured" | "malformed" | "bad_signature" | "wrong_purpose" | "expired" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NONCE = /^[A-Za-z0-9_-]{16,64}$/;

function mac(secret: string, payload: string): Buffer {
  return createHmac("sha256", secret).update(SIGNIN_PREFIX + payload).digest();
}

export function signSigninToken(secret: string, t: SigninToken): string {
  const payload = Buffer.from(JSON.stringify(t)).toString("base64url");
  return `${payload}.${mac(secret, payload).toString("base64url")}`;
}

/** A fresh token for `purpose` (60 s, random nonce). */
export function mintSigninToken(secret: string, purpose: SigninPurpose, user: { uid: string; email: string }, nowMs = Date.now()): string {
  const iat = Math.floor(nowMs / 1000);
  return signSigninToken(secret, {
    v: 1,
    purpose,
    uid: user.uid,
    email: user.email,
    iat,
    exp: iat + SIGNIN_TTL_SECONDS,
    nonce: randomBytes(18).toString("base64url"),
  });
}

/**
 * Signature (constant time), shape, purpose and lifetime. Single use and the
 * account checks are the caller's (they need the database).
 */
export function verifySigninToken(secret: string | undefined, token: string, purpose: SigninPurpose, nowMs = Date.now()): SigninCheck {
  if (!secret) return { ok: false, error: "not_configured" };
  if (typeof token !== "string" || token.length > 2048) return { ok: false, error: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]!) || !/^[A-Za-z0-9_-]+$/.test(parts[1]!)) return { ok: false, error: "malformed" };
  const [payload, sigText] = parts as [string, string];
  const got = Buffer.from(sigText, "base64url");
  const want = mac(secret, payload);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return { ok: false, error: "bad_signature" };
  let t: Partial<SigninToken>;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, error: "malformed" };
    t = parsed as Partial<SigninToken>;
  } catch {
    return { ok: false, error: "malformed" };
  }
  if (
    t.v !== 1 ||
    typeof t.uid !== "string" ||
    !UUID.test(t.uid) ||
    typeof t.email !== "string" ||
    t.email.length > 254 ||
    typeof t.nonce !== "string" ||
    !NONCE.test(t.nonce) ||
    !Number.isInteger(t.iat) ||
    !Number.isInteger(t.exp)
  ) {
    return { ok: false, error: "malformed" };
  }
  if (t.purpose !== purpose) return { ok: false, error: "wrong_purpose" };
  const now = Math.floor(nowMs / 1000);
  const iat = t.iat as number;
  const exp = t.exp as number;
  if (exp - iat > SIGNIN_TTL_SECONDS || iat > now + SIGNIN_CLOCK_SKEW_SECONDS || now >= exp) return { ok: false, error: "expired" };
  return { ok: true, token: t as SigninToken };
}

/**
 * Use the token's nonce up. true the first time, false on any later call.
 * Also sweeps expired rows (they are tiny and only needed for 60 s).
 */
export async function consumeSigninNonce(db: Db, nonce: string, expSeconds: number): Promise<boolean> {
  await db.delete(signinHandoffNonces).where(lt(signinHandoffNonces.expiresAt, sql`now() - interval '1 minute'`));
  const rows = await db
    .insert(signinHandoffNonces)
    // Kept a minute past exp, so it outlives every moment the token could pass the lifetime check.
    .values({ nonce, expiresAt: new Date((expSeconds + 60) * 1000) })
    .onConflictDoNothing({ target: signinHandoffNonces.nonce })
    .returning({ nonce: signinHandoffNonces.nonce });
  return rows.length === 1;
}

/** Was this nonce used? (tests) */
export async function nonceUsed(db: Db, nonce: string): Promise<boolean> {
  const rows = await db.select({ n: signinHandoffNonces.nonce }).from(signinHandoffNonces).where(eq(signinHandoffNonces.nonce, nonce)).limit(1);
  return rows.length === 1;
}

/**
 * The relative, same-origin path to land on, or `fallback`. Only "/..." paths:
 * never "//host", "/\host", a scheme, a backslash or control characters, so
 * the redirect can never leave the app (no open redirect).
 */
export function safeNextPath(raw: unknown, fallback: string): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 500) return fallback;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\") || /[\u0000-\u001f\u007f]/.test(raw)) return fallback;
  try {
    const base = "https://app.invalid";
    const u = new URL(raw, base);
    if (u.origin !== base) return fallback;
    return `${u.pathname}${u.search}${u.hash}`;
  } catch {
    return fallback;
  }
}

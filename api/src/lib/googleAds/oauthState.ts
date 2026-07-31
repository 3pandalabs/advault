import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "../../env.js";

// The OAuth `state` parameter, signed and time-limited.
//
// Without this the callback is a CSRF primitive: an attacker completes the
// Google consent flow with their own ad account, then gets a victim to load the
// resulting callback URL, and the victim's AdVault login ends up holding a
// refresh token for the attacker's account — every campaign the victim launches
// afterwards spends against it. Binding the state to the user id and verifying
// it at the callback is what closes that.
//
// Format: `<userId>.<issuedAtMs>.<nonce>.<hmac>`. Signed with JWT_SECRET rather
// than a separate key — it is the same trust domain (this API's own sessions),
// and a second required secret is a second thing to get wrong at deploy time.

const STATE_TTL_MS = 10 * 60 * 1000;

function sign(payload: string): string {
  return createHmac("sha256", env.JWT_SECRET).update(payload).digest("base64url");
}

export function issueOAuthState(userId: string): string {
  const payload = `${userId}.${Date.now()}.${randomBytes(16).toString("base64url")}`;
  return `${payload}.${sign(payload)}`;
}

// Returns the user id the state was issued to, or null if it is forged,
// malformed, or expired. Callers must use the returned id — never a user id
// taken from the callback request itself, which is exactly the value an
// attacker controls.
export function verifyOAuthState(state: string): string | null {
  const idx = state.lastIndexOf(".");
  if (idx < 0) return null;

  const payload = state.slice(0, idx);
  const presented = Buffer.from(state.slice(idx + 1));
  const expected = Buffer.from(sign(payload));
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    return null;
  }

  const [userId, issuedAt] = payload.split(".");
  if (!userId || !issuedAt) return null;
  if (Date.now() - Number(issuedAt) > STATE_TTL_MS) return null;

  return userId;
}

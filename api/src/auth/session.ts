import { db } from "../db/index.js";
import { sessions } from "../db/schema.js";
import { hashSecret } from "./password.js";
import { generateRefreshSecret, REFRESH_TOKEN_TTL_MS, signAccessToken, type UserRole } from "./jwt.js";

/** A new refresh session for the user: `${sessionId}.${secret}`, only the hash stored. */
export async function issueSession(userId: string): Promise<string> {
  const secret = generateRefreshSecret();
  const [session] = await db
    .insert(sessions)
    .values({
      userId,
      refreshTokenHash: await hashSecret(secret),
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
    })
    .returning({ id: sessions.id });
  return `${session!.id}.${secret}`;
}

/**
 * An access token for the user. A test customer's (users.test_owner_id set)
 * carries `testOwner`, so the dashboard can offer "Back to admin"; the claim
 * comes from the row, never from the caller.
 */
export function accessTokenFor(user: { id: string; role: string; testOwnerId?: string | null }): string {
  return signAccessToken({
    sub: user.id,
    role: user.role as UserRole,
    ...(user.testOwnerId ? { testOwner: user.testOwnerId } : {}),
  });
}

/** Access + refresh token pair, the shape every auth route answers with. */
export async function issueTokens(user: { id: string; role: string; testOwnerId?: string | null }) {
  return { accessToken: accessTokenFor(user), refreshToken: await issueSession(user.id) };
}

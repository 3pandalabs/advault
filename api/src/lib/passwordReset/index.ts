// Password reset, same flow as RsvpVault's forgot/reset. The password lives in
// AdVault's `users` table — the one 3PandaLabs account (lib/sharedAccount) — so
// this serves AdVault's own reset AND the SiteVault-proxied one
// (routes/sitevaultAuth.ts). SiteVault owns its /forgot-password + /reset-password
// pages and the per-IP rate limiting; it passes the product name, the From
// display name and the reset-link base so the email is SiteVault-branded while
// the credential is changed here.
//
// Functions take the database as a parameter (no db/index import) so they run
// against PGlite in tests, matching lib/sharedAccount.

import { randomBytes } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { hashSecret, verifySecret } from "../../auth/password.js";
import { passwordResetTokens, sessions, users } from "../../db/schema.js";
import { actionMail, sendMail } from "../mailer.js";
import type { Db } from "../sharedAccount/index.js";

export const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ResetContext = {
  /** Shown in the email copy, e.g. "SiteVault" or "AdVault". */
  productName: string;
  /** From display name on the email (address is the gateway's shared sender). */
  fromName: string;
  /** Where the link points, e.g. https://sitevault.3pandalabs.com/reset-password */
  resetUrlBase: string;
};

/**
 * Start a reset. Resolves the same way whether or not the account exists (a
 * bcrypt hash is computed either way, and the mail is fire-and-forget), so
 * neither the response nor its timing is an account-enumeration oracle. Mail is
 * sent only for a real, non-deleted account.
 */
export async function requestPasswordReset(db: Db, email: string, ctx: ResetContext, log: (msg: string) => void): Promise<void> {
  const [user] = await db
    .select({ id: users.id, email: users.email, deletedAt: users.deletedAt })
    .from(users)
    .where(eq(users.email, email.trim().toLowerCase()))
    .limit(1);
  const secret = randomBytes(32).toString("base64url");
  const tokenHash = await hashSecret(secret);
  if (!user || user.deletedAt) return;

  await db.delete(passwordResetTokens).where(eq(passwordResetTokens.userId, user.id));
  const [row] = await db
    .insert(passwordResetTokens)
    .values({ userId: user.id, tokenHash, expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS) })
    .returning({ id: passwordResetTokens.id });
  const token = `${row!.id}.${secret}`;
  const sep = ctx.resetUrlBase.includes("?") ? "&" : "?";
  const url = `${ctx.resetUrlBase}${sep}token=${encodeURIComponent(token)}`;
  void sendMail(
    [
      actionMail(
        user.email,
        `Reset your ${ctx.productName} password`,
        `Someone asked to reset the password for your ${ctx.productName} account. The link works once and expires in 30 minutes.`,
        "Choose a new password",
        url,
        "If this wasn't you, you can ignore this email — your password stays the same.",
        ctx.fromName,
      ),
    ],
    log,
  ).catch((err) => log(`password reset mail failed: ${String(err)}`));
}

export type ConfirmResult = { ok: true } | { ok: false };

/**
 * Finish a reset: validate the `<id>.<secret>` token, consume it atomically
 * BEFORE changing the password (two concurrent confirms can't both win), set
 * the new password and sign every device out.
 */
export async function confirmPasswordReset(db: Db, token: string, newPassword: string): Promise<ConfirmResult> {
  const [id, secret] = token.split(".");
  if (!id || !secret || !UUID.test(id)) return { ok: false };
  const [row] = await db.select().from(passwordResetTokens).where(eq(passwordResetTokens.id, id)).limit(1);
  if (!row || !(await verifySecret(secret, row.tokenHash))) return { ok: false };
  const consumed = await db
    .update(passwordResetTokens)
    .set({ usedAt: new Date() })
    .where(and(eq(passwordResetTokens.id, row.id), isNull(passwordResetTokens.usedAt), gt(passwordResetTokens.expiresAt, sql`now()`)))
    .returning({ userId: passwordResetTokens.userId });
  if (!consumed.length) return { ok: false };
  await db.update(users).set({ passwordHash: await hashSecret(newPassword) }).where(eq(users.id, consumed[0]!.userId));
  await db.delete(sessions).where(eq(sessions.userId, consumed[0]!.userId));
  return { ok: true };
}

/** Change a signed-in account's password after proving the current one. */
export async function changePassword(db: Db, email: string, currentPassword: string, newPassword: string): Promise<ConfirmResult> {
  const [user] = await db
    .select({ id: users.id, passwordHash: users.passwordHash, deletedAt: users.deletedAt })
    .from(users)
    .where(eq(users.email, email.trim().toLowerCase()))
    .limit(1);
  if (!user || user.deletedAt || !(await verifySecret(currentPassword, user.passwordHash))) return { ok: false };
  await db.update(users).set({ passwordHash: await hashSecret(newPassword) }).where(eq(users.id, user.id));
  await db.delete(sessions).where(eq(sessions.userId, user.id));
  return { ok: true };
}

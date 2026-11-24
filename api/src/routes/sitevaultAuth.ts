import { timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { users } from "../db/schema.js";
import { sendMail } from "../lib/mailer.js";
import { allowContact, contactBody, contactMail } from "../lib/contact.js";
import { verifySecret } from "../auth/password.js";
import { createSitevaultAccount, markAppUsed, type Db } from "../lib/sharedAccount/index.js";
import { changePassword, confirmPasswordReset, requestPasswordReset } from "../lib/passwordReset/index.js";

// SiteVault's server-to-server window onto the shared 3PandaLabs account
// (AdVault's users table is the one account store for AdVault and SiteVault;
// see lib/sharedAccount). Every route is bearer SITEVAULT_INTERNAL_TOKEN (the
// same shared secret SiteVault's internal API uses) and 401s without it.
//
//   POST /internal/sitevault/verify-login  is this email + password a valid account?
//   POST /internal/sitevault/accounts      create an account signed up on SiteVault
//   POST /internal/sitevault/contact       email us SiteVault's contact form
//   POST /internal/sitevault/usage         stamp the account's first SiteVault use
//
// The database is passed in (index.ts registers with the real one) so the
// routes run against PGlite in tests.

const DUMMY_HASH = "$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidiu";

function bearerOk(header: string | undefined): boolean {
  const expected = process.env.SITEVAULT_INTERNAL_TOKEN;
  if (!expected) return false;
  const got = Buffer.from((header ?? "").replace(/^Bearer\s+/i, ""));
  const want = Buffer.from(expected);
  return got.length === want.length && timingSafeEqual(got, want);
}

const isoTime = z.string().datetime({ offset: true }).optional();

export async function sitevaultAuthRoutes(app: FastifyInstance, opts: { db: Db }) {
  const { db } = opts;

  // onRequest, not in the handlers: a call without the bearer must get 401
  // before its body is parsed or validated, never a 400 describing the schema.
  app.addHook("onRequest", async (req, reply) => {
    if (!bearerOk(req.headers.authorization)) return reply.code(401).send({ ok: false, error: "unauthorized" });
  });

  // SiteVault's /contact form: emailed to us, stored nowhere. SiteVault limits
  // each visitor; the hourly total is shared with AdVault's own form.
  app.post(
    "/internal/sitevault/contact",
    { schema: { body: contactBody.omit({ website: true }).extend({ userId: z.string().uuid().optional() }) } },
    async (req, reply) => {
      const { userId, ...m } = req.body as { userId?: string; name: string; email: string; subject: string; message: string };
      if (!allowContact(null, Date.now())) return reply.code(429).send({ ok: false, error: "rate_limited" });
      const res = await sendMail([contactMail(m, userId, "SiteVault")], (msg) => req.log.info(msg)).catch((err) => {
        req.log.error(err);
        return null;
      });
      if (!res?.delivered) return reply.code(503).send({ ok: false, error: "mailer_unavailable" });
      return reply.code(204).send();
    },
  );

  // SiteVault sign-in with the shared login. Answers only yes (with the user
  // id) or no: never a token, never whether the email exists.
  app.post(
    "/internal/sitevault/verify-login",
    { schema: { body: z.object({ email: z.string().trim().max(254), password: z.string().max(200) }) } },
    async (req, reply) => {
      const { email, password } = req.body as { email: string; password: string };
      const [user] = await db
        .select({ id: users.id, email: users.email, passwordHash: users.passwordHash })
        .from(users)
        .where(eq(users.email, email.toLowerCase()))
        .limit(1);
      // Same timing whether or not the account exists (as /auth/login does).
      const ok = await verifySecret(password, user?.passwordHash ?? DUMMY_HASH);
      if (!user || !ok) return reply.code(401).send({ ok: false, error: "invalid_credentials" });
      return { ok: true, userId: user.id, email: user.email };
    },
  );

  // A SiteVault sign-up (or the lazy move of an older SiteVault-only account,
  // which passes its original createdAt and, when it has a website, the
  // site's first-use time). 201 created. 409 email_exists with the existing
  // id when the email already has an account: nothing on it changes (never
  // the password). SiteVault links that id only after the person proved the
  // SiteVault password for the same email; a fresh sign-up is told to sign in.
  // Password: 8+ chars here, not /auth/register's 10, because SiteVault's
  // older accounts were made with 8; new SiteVault sign-ups ask for 10.
  app.post(
    "/internal/sitevault/accounts",
    {
      schema: {
        body: z.object({
          email: z.string().trim().email().max(254),
          password: z.string().min(8).max(200),
          createdAt: isoTime,
          sitevaultUsedAt: isoTime,
        }),
      },
    },
    async (req, reply) => {
      const body = req.body as { email: string; password: string; createdAt?: string; sitevaultUsedAt?: string };
      const r = await createSitevaultAccount(db, body);
      if (r.status === "exists") return reply.code(409).send({ ok: false, error: "email_exists", userId: r.userId, email: r.email });
      req.log.info({ userId: r.userId }, "account created from sitevault");
      return reply.code(201).send({ ok: true, userId: r.userId, email: r.email });
    },
  );

  // The account made or claimed a SiteVault website. Idempotent; the stamp
  // only ever moves earlier. 404 for an unknown or deleted account.
  app.post(
    "/internal/sitevault/usage",
    { schema: { body: z.object({ userId: z.string().uuid(), at: isoTime }) } },
    async (req, reply) => {
      const { userId, at } = req.body as { userId: string; at?: string };
      if (!(await markAppUsed(db, userId, "sitevault", at))) return reply.code(404).send({ ok: false, error: "not_found" });
      return { ok: true };
    },
  );

  // Password reset, proxied from SiteVault's own /forgot-password and
  // /reset-password pages (the password lives here, so only AdVault can mint
  // the token and set the new one). SiteVault does the per-IP rate limiting on
  // its public pages; it passes the product name, the From display name and the
  // reset-link base so the email is SiteVault-branded. Enumeration-safe: request
  // always answers 204, whether or not the email has an account.
  app.post(
    "/internal/sitevault/password-reset/request",
    {
      schema: {
        body: z.object({
          email: z.string().trim().email().max(254),
          resetUrlBase: z.string().url().max(300),
          productName: z.string().trim().min(1).max(40),
          fromName: z.string().trim().min(1).max(60),
        }),
      },
    },
    async (req, reply) => {
      const b = req.body as { email: string; resetUrlBase: string; productName: string; fromName: string };
      await requestPasswordReset(db, b.email, { resetUrlBase: b.resetUrlBase, productName: b.productName, fromName: b.fromName }, (m) =>
        req.log.info(m),
      );
      return reply.code(204).send();
    },
  );

  // Finish the reset: the single-use token plus the new password. 400 for a
  // bad, used or expired token. New password is 8+, matching the internal
  // account create (SiteVault's older accounts were made with 8).
  app.post(
    "/internal/sitevault/password-reset/confirm",
    { schema: { body: z.object({ token: z.string().min(1).max(500), password: z.string().min(8).max(200) }) } },
    async (req, reply) => {
      const b = req.body as { token: string; password: string };
      const r = await confirmPasswordReset(db, b.token, b.password);
      if (!r.ok) return reply.code(400).send({ ok: false, error: "invalid_or_expired_token" });
      return { ok: true };
    },
  );

  // Change password for a signed-in SiteVault user: verify the current one here,
  // set the new one. 401 when the current password is wrong.
  app.post(
    "/internal/sitevault/change-password",
    {
      schema: {
        body: z.object({
          email: z.string().trim().email().max(254),
          currentPassword: z.string().min(1).max(200),
          newPassword: z.string().min(8).max(200),
        }),
      },
    },
    async (req, reply) => {
      const b = req.body as { email: string; currentPassword: string; newPassword: string };
      const r = await changePassword(db, b.email, b.currentPassword, b.newPassword);
      if (!r.ok) return reply.code(401).send({ ok: false, error: "invalid_credentials" });
      return { ok: true };
    },
  );
}

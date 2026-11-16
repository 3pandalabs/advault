import { timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { users } from "../db/schema.js";
import { verifySecret } from "../auth/password.js";
import { createSitevaultAccount, markAppUsed, type Db } from "../lib/sharedAccount/index.js";

// SiteVault's server-to-server window onto the shared 3PandaLabs account
// (AdVault's users table is the one account store for AdVault and SiteVault;
// see lib/sharedAccount). Every route is bearer SITEVAULT_INTERNAL_TOKEN (the
// same shared secret SiteVault's internal API uses) and 401s without it.
//
//   POST /internal/sitevault/verify-login  is this email + password a valid account?
//   POST /internal/sitevault/accounts      create an account signed up on SiteVault
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

  // SiteVault sign-in with the shared login. Answers only yes (with the user
  // id) or no: never a token, never whether the email exists.
  app.post(
    "/internal/sitevault/verify-login",
    { schema: { body: z.object({ email: z.string().trim().max(254), password: z.string().max(200) }) } },
    async (req, reply) => {
      if (!bearerOk(req.headers.authorization)) return reply.code(401).send({ ok: false, error: "unauthorized" });
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
      if (!bearerOk(req.headers.authorization)) return reply.code(401).send({ ok: false, error: "unauthorized" });
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
      if (!bearerOk(req.headers.authorization)) return reply.code(401).send({ ok: false, error: "unauthorized" });
      const { userId, at } = req.body as { userId: string; at?: string };
      if (!(await markAppUsed(db, userId, "sitevault", at))) return reply.code(404).send({ ok: false, error: "not_found" });
      return { ok: true };
    },
  );
}

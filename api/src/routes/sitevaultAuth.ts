import { timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../db/index.js";
import { users } from "../db/schema.js";
import { verifySecret } from "../auth/password.js";

// SiteVault sign-in with AdVault credentials (2026-11-15). SiteVault's login
// form posts the email + password here, server to server, so an AdVault
// customer signs in to SiteVault with the same login. Bearer
// SITEVAULT_INTERNAL_TOKEN (the same shared secret SiteVault's internal API
// uses). Answers only yes (with the user id) or no: never a token, never
// whether the email exists.

const DUMMY_HASH = "$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidiu";

function bearerOk(header: string | undefined): boolean {
  const expected = process.env.SITEVAULT_INTERNAL_TOKEN;
  if (!expected) return false;
  const got = Buffer.from((header ?? "").replace(/^Bearer\s+/i, ""));
  const want = Buffer.from(expected);
  return got.length === want.length && timingSafeEqual(got, want);
}

export async function sitevaultAuthRoutes(app: FastifyInstance) {
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
}

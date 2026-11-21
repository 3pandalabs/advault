// One-tap sign-in between SiteVault and AdVault (2026-11-20,
// lib/signinHandoff has the token format and why).
//
//   POST /auth/handoff            SiteVault -> AdVault: exchange a
//                                 "signin-advault" token (minted by SiteVault
//                                 GET /go/advault, carried by the web page
//                                 /auth/handoff?t=) for the normal token pair,
//                                 exactly as /auth/login issues it.
//   POST /auth/sitevault-handoff  AdVault -> SiteVault (signed in): a 60 s
//                                 SiteVault /auth/handoff URL that signs this
//                                 user in there. { url: null } when it can't
//                                 (not configured, admin): the caller uses the
//                                 plain SiteVault link.
//
// Every refusal is the same 401 `handoff_refused`, so a caller learns nothing
// about why; the web page then sends the person to the normal /login. The
// reason is logged, never the token.

import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../auth/plugin.js";
import { issueTokens } from "../auth/session.js";
import { db } from "../db/index.js";
import { users } from "../db/schema.js";
import { consumeSigninNonce, mintSigninToken, safeNextPath, verifySigninToken } from "../lib/signinHandoff/index.js";
import { SITEVAULT_URL } from "../lib/sitevault/index.js";
import { isUndeliverableEmail } from "../lib/testMode/policy.js";
import type { Db } from "../lib/sharedAccount/index.js";

export async function signinHandoffRoutes(app: FastifyInstance) {
  app.post("/auth/handoff", { schema: { body: z.object({ token: z.string().min(1).max(2048) }) } }, async (req, reply) => {
    reply.header("cache-control", "no-store");
    const refuse = (reason: string) => {
      req.log.warn({ reason }, "signin_handoff_refused");
      return reply.code(401).send({ error: "handoff_refused" });
    };
    const checked = verifySigninToken(process.env.SITEVAULT_INTERNAL_TOKEN, (req.body as { token: string }).token, "signin-advault");
    if (!checked.ok) return refuse(checked.error);
    const t = checked.token;
    // Single use before anything else, so a refused token can't be retried either.
    if (!(await consumeSigninNonce(db as unknown as Db, t.nonce, t.exp))) return refuse("reused");
    const [user] = await db
      .select({ id: users.id, email: users.email, role: users.role, testOwnerId: users.testOwnerId, deletedAt: users.deletedAt })
      .from(users)
      .where(eq(users.id, t.uid))
      .limit(1);
    if (!user || user.deletedAt) return refuse("no_user");
    // Admins sign in by hand; a test customer is only entered from its admin
    // (as /auth/login refuses it too).
    if (user.role === "admin") return refuse("admin");
    if (user.testOwnerId) return refuse("test_customer");
    if (!t.email || t.email.trim().toLowerCase() !== user.email.toLowerCase()) return refuse("email_mismatch");
    req.log.info({ userId: user.id }, "signed in from sitevault");
    return issueTokens({ id: user.id, role: user.role, testOwnerId: user.testOwnerId });
  });

  app.post(
    "/auth/sitevault-handoff",
    { preHandler: requireAuth, schema: { body: z.object({ to: z.string().max(500).optional() }).optional() } },
    async (req, reply) => {
      // The URL signs the user in on SiteVault: never cache it.
      reply.header("cache-control", "no-store");
      const secret = process.env.SITEVAULT_INTERNAL_TOKEN;
      if (!secret) return { url: null };
      const [user] = await db
        .select({ id: users.id, email: users.email, role: users.role, deletedAt: users.deletedAt })
        .from(users)
        .where(eq(users.id, req.userId!))
        .limit(1);
      // The REAL role (test mode or not): admins sign in to SiteVault by hand.
      if (!user || user.deletedAt || user.role === "admin") return { url: null };
      const to = safeNextPath((req.body as { to?: string } | undefined)?.to, "/account");
      const token = mintSigninToken(secret, "signin-sitevault", {
        uid: user.id,
        // A test customer's *.invalid address is never sent: SiteVault finds the account by id.
        email: isUndeliverableEmail(user.email) ? "" : user.email.toLowerCase(),
      });
      return { url: `${SITEVAULT_URL}/auth/handoff?t=${encodeURIComponent(token)}&to=${encodeURIComponent(to)}` };
    },
  );
}

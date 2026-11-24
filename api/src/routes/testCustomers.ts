import crypto from "node:crypto";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { parseRefreshToken } from "../auth/jwt.js";
import { hashSecret } from "../auth/password.js";
import { requireAuth } from "../auth/plugin.js";
import { issueTokens } from "../auth/session.js";
import { db } from "../db/index.js";
import { sessions, users } from "../db/schema.js";
import { maySwitchInto } from "../lib/testMode/policy.js";

// Admin test customers (2026-11-17, migration 0030). Everything one-per-account
// (website, Google Ads child account, Mercury card, plan) gets "used up" on the
// admin's own login, so a real admin can make separate customer accounts and
// switch into them to walk the new-customer path again.
//
// A test customer is an ordinary `users` row with `test_owner_id` = the admin:
// role advertiser, a *.invalid email (no mail can reach anyone), a random
// password nobody knows (it cannot log in; /auth/login also refuses it).
// lib/testMode treats it as test mode for good: $0.50 charges tagged
// test_mode=1, and launch is forced to a dry run (routes/launch.ts).
//
// Switching issues a normal session (access + refresh token, the same pair
// /auth/login returns) for the other user. A session inside a test customer
// carries the `testOwner` claim (auth/session.ts), and "Back to admin" is only
// accepted from such a session, re-checked against users.test_owner_id.
// The owner's REAL role is read from the database every time, never the JWT.

const MAX_TEST_CUSTOMERS = 50;

/**
 * The admin these calls act for: the caller when they are a real admin, or
 * the owner when the caller is inside one of that admin's test customers.
 * Null = not allowed (403).
 */
export async function testCustomerOwner(req: FastifyRequest): Promise<string | null> {
  let ownerId = req.userId!;
  if (req.testOwnerClaim) {
    const [me] = await db.select({ testOwnerId: users.testOwnerId }).from(users).where(eq(users.id, req.userId!)).limit(1);
    if (!me || me.testOwnerId !== req.testOwnerClaim) return null;
    ownerId = req.testOwnerClaim;
  }
  const [owner] = await db
    .select({ role: users.role, deletedAt: users.deletedAt, testOwnerId: users.testOwnerId })
    .from(users)
    .where(eq(users.id, ownerId))
    .limit(1);
  if (!owner || owner.deletedAt || owner.role !== "admin" || owner.testOwnerId) return null;
  return ownerId;
}

/** Ends the session the caller is leaving, if the token is theirs. Best effort. */
async function endSession(refreshToken: string | undefined, userId: string): Promise<void> {
  const parsed = refreshToken ? parseRefreshToken(refreshToken) : null;
  if (!parsed) return;
  await db
    .delete(sessions)
    .where(and(eq(sessions.id, parsed.sessionId), eq(sessions.userId, userId)))
    .catch(() => undefined);
}

const nameOf = (u: { displayName: string | null; businessName: string | null }) =>
  u.businessName ?? u.displayName ?? "Test customer";

const leaving = z.object({ refreshToken: z.string().min(1).max(500).optional() }).optional();

export async function testCustomerRoutes(app: FastifyInstance) {
  app.get("/test-customers", { onRequest: requireAuth }, async (req, reply) => {
    const ownerId = await testCustomerOwner(req);
    if (!ownerId) return reply.code(403).send({ error: "admin_role_required" });
    const rows = await db
      .select({ id: users.id, displayName: users.displayName, businessName: users.businessName, createdAt: users.createdAt })
      .from(users)
      .where(and(eq(users.testOwnerId, ownerId), isNull(users.deletedAt)))
      .orderBy(asc(users.createdAt));
    return {
      customers: rows.map((r) => ({ id: r.id, name: nameOf(r), createdAt: r.createdAt })),
      /** The test customer this session is inside, or null for the admin's own. */
      current: req.userId === ownerId ? null : req.userId,
    };
  });

  app.post(
    "/test-customers",
    { onRequest: requireAuth, schema: { body: z.object({ name: z.string().trim().min(1).max(120) }) } },
    async (req, reply) => {
      const ownerId = await testCustomerOwner(req);
      if (!ownerId) return reply.code(403).send({ error: "admin_role_required" });
      const { name } = req.body as { name: string };

      const existing = await db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.testOwnerId, ownerId), isNull(users.deletedAt)));
      if (existing.length >= MAX_TEST_CUSTOMERS) return reply.code(409).send({ error: "too_many_test_customers" });

      const [row] = await db
        .insert(users)
        .values({
          // RFC 2606 reserved TLD: undeliverable by definition.
          email: `test-${crypto.randomBytes(6).toString("hex")}@test.advault.invalid`,
          // Nobody knows this password; the account is entered only by switching.
          passwordHash: await hashSecret(crypto.randomBytes(32).toString("hex")),
          displayName: name,
          businessName: name,
          role: "advertiser",
          testOwnerId: ownerId,
        })
        .returning({ id: users.id, displayName: users.displayName, businessName: users.businessName, createdAt: users.createdAt });
      req.log.info({ ownerId, testCustomerId: row!.id }, "test customer created");
      return reply.code(201).send({ id: row!.id, name: nameOf(row!), createdAt: row!.createdAt });
    },
  );

  // Switch this session into one of the owner's test customers. Answers the
  // same token pair as /auth/login; the browser swaps its stored tokens.
  app.post(
    "/test-customers/:id/switch",
    { onRequest: requireAuth, schema: { params: z.object({ id: z.string().uuid() }), body: leaving } },
    async (req, reply) => {
      const ownerId = await testCustomerOwner(req);
      if (!ownerId) return reply.code(403).send({ error: "admin_role_required" });
      const { id } = req.params as { id: string };
      const [target] = await db
        .select({ id: users.id, role: users.role, testOwnerId: users.testOwnerId, deletedAt: users.deletedAt })
        .from(users)
        .where(eq(users.id, id))
        .limit(1);
      if (!target || !maySwitchInto({ actorOwnerId: ownerId, target })) {
        return reply.code(404).send({ error: "test_customer_not_found" });
      }
      const tokens = await issueTokens(target);
      await endSession((req.body as { refreshToken?: string } | undefined)?.refreshToken, req.userId!);
      req.log.info({ ownerId, from: req.userId, to: target.id }, "switched into test customer");
      return tokens;
    },
  );

  // "Back to admin": only from a session inside a test customer.
  app.post("/test-customers/back", { onRequest: requireAuth, schema: { body: leaving } }, async (req, reply) => {
    if (!req.testOwnerClaim) return reply.code(403).send({ error: "not_in_test_customer" });
    const ownerId = await testCustomerOwner(req);
    if (!ownerId) return reply.code(403).send({ error: "not_in_test_customer" });
    const tokens = await issueTokens({ id: ownerId, role: "admin" });
    await endSession((req.body as { refreshToken?: string } | undefined)?.refreshToken, req.userId!);
    req.log.info({ ownerId, from: req.userId }, "switched back to admin");
    return tokens;
  });
}

import { and, asc, count, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireAuth } from "../auth/plugin.js";
import { db } from "../db/index.js";
import { users } from "../db/schema.js";
import { roleChangeBlock, type Role } from "../lib/adminUsers/policy.js";

// Admins page: find a user and make them an admin (or back to a normal user).
//
// Session admins only, never the ADMIN_ANALYTICS_TOKEN: handing out admin is
// the most powerful thing in the app (admins pay nothing and skip review), so
// it needs a person. The caller's role is re-read from the database rather
// than trusted from the access token, so a just-demoted admin can't use a
// token that still says "admin". The target's new role applies at their next
// sign-in or token refresh.

const listQuery = z.object({ q: z.string().trim().max(200).optional() });
const internalBody = z.object({
  email: z.string().trim().min(3).max(320),
  internal: z.boolean(),
  label: z.string().trim().max(60).optional(),
});
const testBody = z.object({
  email: z.string().trim().min(3).max(320),
  test: z.boolean(),
});
const roleBody = z.object({ role: z.enum(["advertiser", "admin"]) });

async function requireDbAdmin(req: FastifyRequest, reply: FastifyReply) {
  const [me] = await db.select({ role: users.role, deletedAt: users.deletedAt }).from(users).where(eq(users.id, req.userId!));
  if (!me || me.deletedAt || me.role !== "admin") return reply.code(403).send({ error: "admin_role_required" });
}

const columns = {
  id: users.id,
  email: users.email,
  displayName: users.displayName,
  businessName: users.businessName,
  role: users.role,
  signupApp: users.signupApp,
  isInternal: users.isInternal,
  internalLabel: users.internalLabel,
  markedTest: users.markedTest,
  createdAt: users.createdAt,
};

export async function adminUserRoutes(app: FastifyInstance) {
  app.get(
    "/admin/users",
    { onRequest: [requireAuth, requireDbAdmin], schema: { querystring: listQuery } },
    async (req) => {
      const q = (req.query as z.infer<typeof listQuery>).q ?? "";
      const live = isNull(users.deletedAt);
      // Escape LIKE wildcards so a search is literal.
      const like = `%${q.replace(/[\%_]/g, (c) => `\${c}`)}%`;
      const where = q
        ? and(live, or(ilike(users.email, like), ilike(users.displayName, like), ilike(users.businessName, like)))
        : live;
      const rows = await db
        .select(columns)
        .from(users)
        .where(where)
        // Admins first, then newest sign-ups.
        .orderBy(sql`${users.role} = 'admin' desc`, desc(users.createdAt), asc(users.email))
        .limit(50);
      return { users: rows };
    },
  );

  // Internal accounts (0032): 3PandaLabs advertising its own apps through
  // AdVault as a normal full-price customer. The flag changes NO price, gate
  // or launch; it only keeps the account out of revenue / traction numbers,
  // tags Stripe (`internal=1`) and prefixes "INTERNAL · " on ops-facing names.
  app.get("/admin/internal-accounts", { onRequest: [requireAuth, requireDbAdmin] }, async () => {
    const rows = await db
      .select(columns)
      .from(users)
      .where(and(eq(users.isInternal, true), isNull(users.deletedAt)))
      .orderBy(asc(users.internalLabel), asc(users.email));
    return { users: rows };
  });

  app.post(
    "/admin/internal-accounts",
    { onRequest: [requireAuth, requireDbAdmin], schema: { body: internalBody } },
    async (req, reply) => {
      const { email, internal, label } = req.body as z.infer<typeof internalBody>;
      const [target] = await db
        .select({ id: users.id, testOwnerId: users.testOwnerId })
        .from(users)
        .where(and(sql`lower(${users.email}) = lower(${email})`, isNull(users.deletedAt)))
        .limit(1);
      if (!target) return reply.code(404).send({ error: "not_found" });
      // A test customer is already out of every number and test-priced.
      if (target.testOwnerId) return reply.code(409).send({ error: "test_customer" });
      const [row] = await db
        .update(users)
        .set({ isInternal: internal, internalLabel: internal ? label || null : null })
        .where(eq(users.id, target.id))
        .returning(columns);
      req.log.info({ actor: req.userId, target: target.id, internal, label }, "internal account changed");
      return { user: row };
    },
  );

  // Accounts marked as test (0046): an ordinary account that is really ours
  // (the Play reviewer's demo login, our own QA). The flag changes NO login,
  // price, gate or launch; it only keeps the account out of real customers,
  // revenue and traction numbers. Unlike a test customer (test_owner_id) it
  // can still sign in and launch for real.
  app.get("/admin/test-accounts", { onRequest: [requireAuth, requireDbAdmin] }, async () => {
    const rows = await db
      .select(columns)
      .from(users)
      .where(and(eq(users.markedTest, true), isNull(users.deletedAt)))
      .orderBy(asc(users.email));
    return { users: rows };
  });

  app.post(
    "/admin/test-accounts",
    { onRequest: [requireAuth, requireDbAdmin], schema: { body: testBody } },
    async (req, reply) => {
      const { email, test } = req.body as z.infer<typeof testBody>;
      const [target] = await db
        .select({ id: users.id, role: users.role, testOwnerId: users.testOwnerId })
        .from(users)
        .where(and(sql`lower(${users.email}) = lower(${email})`, isNull(users.deletedAt)))
        .limit(1);
      if (!target) return reply.code(404).send({ error: "not_found" });
      // Already out of every number: a test customer, or an admin.
      if (target.testOwnerId) return reply.code(409).send({ error: "test_customer" });
      if (target.role === "admin") return reply.code(409).send({ error: "admin_account" });
      const [row] = await db.update(users).set({ markedTest: test }).where(eq(users.id, target.id)).returning(columns);
      req.log.info({ actor: req.userId, target: target.id, test }, "test account mark changed");
      return { user: row };
    },
  );

  app.post(
    "/admin/users/:id/role",
    {
      onRequest: [requireAuth, requireDbAdmin],
      schema: { params: z.object({ id: z.string().uuid() }), body: roleBody },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const { role } = req.body as z.infer<typeof roleBody>;
      const result = await db.transaction(async (tx) => {
        // Serialise role changes so two admins can't each remove the other
        // and leave nobody.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext('advault_admin_roles'))`);
        const [target] = await tx
          .select({ role: users.role, deletedAt: users.deletedAt })
          .from(users)
          .where(eq(users.id, id));
        if (!target) return { error: "not_found" as const };
        const [{ n }] = await tx
          .select({ n: count() })
          .from(users)
          .where(and(eq(users.role, "admin"), isNull(users.deletedAt)));
        const block = roleChangeBlock({
          actorId: req.userId!,
          targetId: id,
          targetRole: target.role as Role,
          targetDeleted: !!target.deletedAt,
          newRole: role,
          adminCount: Number(n),
        });
        if (block) return { error: block };
        const [row] = await tx.update(users).set({ role }).where(eq(users.id, id)).returning(columns);
        return { user: row };
      });
      if ("error" in result) return reply.code(result.error === "not_found" ? 404 : 409).send({ error: result.error });
      req.log.info({ actor: req.userId, target: id, role }, "admin role changed");
      return result;
    },
  );
}

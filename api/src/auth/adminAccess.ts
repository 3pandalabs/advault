import type { FastifyReply, FastifyRequest } from "fastify";
import { env } from "../env.js";
import { secretEquals } from "../lib/crypto.js";

// An admin user session, OR the optional ADMIN_ANALYTICS_TOKEN bearer for a
// server-side caller such as the org admin site's Worker (see env.ts for why
// it is not METRICS_TOKEN). Used by /admin/metrics and /admin/video-reviews.
//
// Not combined with a route-level requireAuth hook: a token caller has no
// session, so req.userId is unset for it.
export async function requireAdminOrAnalyticsToken(req: FastifyRequest, reply: FastifyReply) {
  if (req.userRole === "admin") return;
  const header = req.headers.authorization ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (env.ADMIN_ANALYTICS_TOKEN && presented && secretEquals(presented, env.ADMIN_ANALYTICS_TOKEN)) {
    return;
  }
  if (!req.userId) return reply.code(401).send({ error: "not_authenticated" });
  return reply.code(403).send({ error: "admin_role_required" });
}

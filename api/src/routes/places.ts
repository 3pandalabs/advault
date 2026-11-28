import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../auth/plugin.js";
import { db } from "../db/index.js";
import { users } from "../db/schema.js";
import { PLACE_ID_RE, PlacesError, allowPlacesCall, placeDetails, placesConfigured, searchPlaces } from "../lib/places/index.js";

// "Find my business on Google" (2026-11-27, lib/places). Signed-in owners only,
// rate-limited per user. GET /places/enabled lets the web hide the step when
// GOOGLE_PLACES_API_KEY is unset.

export async function placeRoutes(app: FastifyInstance) {
  app.register(async (secured) => {
    secured.addHook("onRequest", requireAuth);

    secured.get("/places/enabled", async () => ({ enabled: placesConfigured() }));

    secured.post(
      "/places/search",
      { schema: { body: z.object({ query: z.string().trim().min(2).max(200) }) } },
      async (req, reply) => {
        if (!placesConfigured()) return reply.code(503).send({ error: "places_not_configured" });
        if (!allowPlacesCall(req.userId!)) return reply.code(429).send({ error: "rate_limited" });
        const [u] = await db.select({ countryCode: users.countryCode }).from(users).where(eq(users.id, req.userId!)).limit(1);
        try {
          return { results: await searchPlaces((req.body as { query: string }).query, u?.countryCode === "IN" ? "IN" : "US") };
        } catch (err) {
          req.log.warn({ err: String(err) }, "places search failed");
          return reply.code(502).send({ error: err instanceof PlacesError ? err.message : "places_unavailable" });
        }
      },
    );

    secured.get(
      "/places/:placeId",
      { schema: { params: z.object({ placeId: z.string().regex(PLACE_ID_RE) }) } },
      async (req, reply) => {
        if (!placesConfigured()) return reply.code(503).send({ error: "places_not_configured" });
        if (!allowPlacesCall(req.userId!)) return reply.code(429).send({ error: "rate_limited" });
        try {
          const d = await placeDetails((req.params as { placeId: string }).placeId);
          if (!d) return reply.code(404).send({ error: "not_found" });
          // Shown to the owner to fill in their own fields; not stored here.
          reply.header("cache-control", "no-store");
          return d;
        } catch (err) {
          req.log.warn({ err: String(err) }, "places details failed");
          return reply.code(502).send({ error: "places_unavailable" });
        }
      },
    );
  });
}

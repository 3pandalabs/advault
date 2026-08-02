import cors from "@fastify/cors";
import Fastify, { type FastifyError } from "fastify";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import { authPlugin } from "./auth/plugin.js";
import { env } from "./env.js";
import { recordRequest, startCpuSampler } from "./metrics/collector.js";
import { adAccountRoutes } from "./routes/adAccounts.js";
import { assetRoutes } from "./routes/assets.js";
import { authRoutes } from "./routes/auth.js";
import { billingRoutes } from "./routes/billing.js";
import { campaignRoutes } from "./routes/campaigns.js";
import { creativeRoutes } from "./routes/creatives.js";
import { launchRoutes } from "./routes/launch.js";
import { metricsRoutes } from "./routes/metrics.js";

const app = Fastify({
  logger: true,
  // Coolify's Traefik terminates TLS and proxies over the private Docker
  // network, so the socket's remote address is always the proxy. Without this,
  // req.ip is useless for rate limiting or any per-client accounting.
  trustProxy: true,
}).withTypeProvider<ZodTypeProvider>();

app.setValidatorCompiler(validatorCompiler);
app.setSerializerCompiler(serializerCompiler);

// Payment webhooks are authenticated by an HMAC over the EXACT bytes received.
// Fastify's default JSON parser would hand the route a parsed object, and an
// HMAC recomputed over a re-serialised body never matches — different
// whitespace, different key order. So keep the raw string alongside the parsed
// body and let lib/payments verify against it.
//
// Scoped to routes that opt in via `config.rawBody`, so normal routes keep the
// default parser and pay nothing for this.
app.addContentTypeParser(
  "application/json",
  { parseAs: "string" },
  (req, body: string, done) => {
    if ((req.routeOptions?.config as { rawBody?: boolean } | undefined)?.rawBody) {
      (req as unknown as { rawBody: string }).rawBody = body;
    }
    try {
      done(null, body.length ? JSON.parse(body) : undefined);
    } catch (err) {
      done(err as Error, undefined);
    }
  },
);

await app.register(cors, { origin: env.CORS_ORIGINS, credentials: true });
await app.register(authPlugin);

app.get("/health", async () => ({ ok: true }));

// Feeds the rolling requests-per-hour figure behind GET /metrics. Both ops
// endpoints are excluded so dashboard polling and container health checks don't
// register as app traffic.
startCpuSampler();
app.addHook("onResponse", async (req) => {
  if (req.url !== "/metrics" && req.url !== "/health") recordRequest();
});

app.setErrorHandler((err: FastifyError & { code?: string }, req, reply) => {
  // Postgres unique_violation — e.g. a race reconnecting the same ad account —
  // is a conflict, not a server fault.
  if (err.code === "23505") {
    return reply.code(409).send({ error: "conflict" });
  }
  // A CHECK constraint rejecting a value means the request body was invalid in
  // a way the Zod schema didn't catch (usually a cross-field rule, like an
  // empty target ZIP array reaching campaigns_zips_check).
  if (err.code === "23514") {
    return reply.code(400).send({ error: "invalid_request" });
  }
  if (err.validation) {
    return reply.code(400).send({ error: "invalid_request", details: err.validation });
  }
  // Anything Fastify itself rejected before the handler ran — an empty body
  // declared as application/json, an unsupported content type, a payload over
  // the limit. These carry a 4xx statusCode already, and answering
  // "internal_error" for them actively misleads: it points debugging at the
  // server when the request was malformed.
  const status = err.statusCode ?? 500;
  if (status < 500) {
    return reply.code(status).send({ error: err.code ?? "bad_request" });
  }
  req.log.error(err);
  return reply.code(status).send({ error: "internal_error" });
});

await app.register(authRoutes);
// Pricing + wallet + payment webhooks. The /pricing routes inside are
// deliberately public — the landing-page calculator is the top of the funnel
// and must work before signup.
await app.register(billingRoutes);
await app.register(assetRoutes);
await app.register(campaignRoutes);
await app.register(creativeRoutes);
await app.register(adAccountRoutes);
// Registered last and on its own, because it is the only route in this app
// that spends an advertiser's money. Keeping it visibly separate in this list
// is deliberate — see routes/launch.ts.
await app.register(launchRoutes);
await app.register(metricsRoutes);

app.listen({ port: env.PORT, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});

import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../db/index.js";
import { env } from "../env.js";
import { secretEquals } from "../lib/crypto.js";
import { cpuPercentOfOneCore, requestsLastHour } from "../metrics/collector.js";

// Ops-only endpoint, scraped by the admin page (admin.3pandalabs.com). The
// admin Worker calls this server-side and holds the token as a Worker secret,
// so it never reaches a browser.
//
// Deliberately outside the product API surface: no JWT, its own bearer token,
// and aggregate counts only — nothing here identifies an advertiser, names a
// business, or reports a spend figure tied to one account.
//
// The response envelope (app/collectedAt/uptimeSeconds/counts/traffic/process/
// database) is shared across every 3PandaLabs app so the admin page's rendering
// script stays generic. Change the `counts` keys freely — that is the per-app
// part — but not the shape around them.

type CountsRow = {
  advertisers: number;
  campaigns: number;
  live_campaigns: number;
  creatives: number;
  rendered_creatives: number;
  failed_creatives: number;
  queued_render_jobs: number;
  connected_ad_accounts: number;
  active_sessions: number;
};

type DatabaseRow = {
  size_bytes: string;
  size_pretty: string;
  connections: number;
};

export async function metricsRoutes(app: FastifyInstance) {
  app.get("/metrics", async (req, reply) => {
    if (!env.METRICS_TOKEN) {
      // Unset rather than wrong: the container still boots without the env var
      // so a deploy can never be bricked by a missing ops secret.
      return reply.code(503).send({ error: "metrics_disabled" });
    }

    const header = req.headers.authorization ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!secretEquals(presented, env.METRICS_TOKEN)) {
      return reply.code(401).send({ error: "unauthorized" });
    }

    const counts = await db.execute<CountsRow>(sql`
      select
        (select count(*) from users)::int as advertisers,
        (select count(*) from campaigns)::int as campaigns,
        (select count(*) from campaigns where status = 'live')::int as live_campaigns,
        (select count(*) from creatives)::int as creatives,
        (select count(*) from creatives where render_status = 'ready')::int as rendered_creatives,
        (select count(*) from creatives where render_status = 'failed')::int as failed_creatives,
        (select count(*) from render_jobs where status in ('queued','running'))::int as queued_render_jobs,
        (select count(*) from ad_accounts where status = 'active')::int as connected_ad_accounts,
        (select count(*) from sessions where expires_at > now())::int as active_sessions
    `);

    const database = await db.execute<DatabaseRow>(sql`
      select
        pg_database_size(current_database()) as size_bytes,
        pg_size_pretty(pg_database_size(current_database())) as size_pretty,
        (select count(*) from pg_stat_activity where datname = current_database())::int as connections
    `);

    const c = counts.rows[0];
    const d = database.rows[0];
    const mem = process.memoryUsage();

    return {
      app: "advault",
      collectedAt: new Date().toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      counts: {
        advertisers: c.advertisers,
        campaigns: c.campaigns,
        liveCampaigns: c.live_campaigns,
        creatives: c.creatives,
        renderedCreatives: c.rendered_creatives,
        failedCreatives: c.failed_creatives,
        // The one worth alerting on. A queue that climbs and never drains means
        // the advault-renderer container is down or crash-looping, and nothing
        // else in this envelope would show it — the API stays perfectly healthy
        // while every advertiser's video sits unrendered.
        queuedRenderJobs: c.queued_render_jobs,
        connectedAdAccounts: c.connected_ad_accounts,
        activeSessions: c.active_sessions,
      },
      traffic: {
        // Rolling 60 minutes, in-process — see metrics/collector.ts. Resets on
        // restart, and counts only this replica.
        apiRequestsLastHour: requestsLastHour(),
      },
      process: {
        // API container only. The renderer is a separate container with no HTTP
        // surface, so its RAM and CPU show up in the host totals from
        // node-exporter, not here.
        rssBytes: mem.rss,
        heapUsedBytes: mem.heapUsed,
        cpuPercentOfOneCore: cpuPercentOfOneCore(),
      },
      database: {
        sizeBytes: Number(d.size_bytes),
        sizePretty: d.size_pretty,
        connections: d.connections,
      },
    };
  });
}

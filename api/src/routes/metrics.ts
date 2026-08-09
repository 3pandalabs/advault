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
  platform_funded_accounts: number;
  customer_funded_accounts: number;
  billing_link_incomplete: number;
  active_sessions: number;
  paying_subscribers: number;
  past_due_subscribers: number;
  mrr_minor_inr: number;
  mrr_minor_usd: number;
  wallet_balance_minor_inr: number;
  wallet_balance_minor_usd: number;
  offers_awaiting_reply: number;
  offers_approved_this_month: number;
  cinematic_awaiting_production: number;
  cinematic_delivered: number;
  cinematic_failed_unrefunded: number;
  add_on_revenue_minor_inr: number;
  add_on_revenue_minor_usd: number;
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
        (select count(*) from ad_accounts where status = 'active' and billing_mode = 'platform')::int as platform_funded_accounts,
        (select count(*) from ad_accounts where status = 'active' and billing_mode = 'customer')::int as customer_funded_accounts,
        (select count(*) from ad_accounts where status = 'active' and billing_link_status in ('pending','invited'))::int as billing_link_incomplete,
        (select count(*) from sessions where expires_at > now())::int as active_sessions,
        -- Revenue. Until subscriptions existed these were all structurally zero:
        -- every plan carried a monthly fee of 0 and no 'fee' ledger row was ever
        -- written, so "is this product earning anything" was unanswerable from
        -- the admin page.
        (select count(*) from subscriptions where status = 'active')::int as paying_subscribers,
        (select count(*) from subscriptions where status = 'past_due')::int as past_due_subscribers,
        (select coalesce(sum(amount_minor), 0) from subscriptions where status in ('active','past_due') and currency_code = 'INR')::int as mrr_minor_inr,
        (select coalesce(sum(amount_minor), 0) from subscriptions where status in ('active','past_due') and currency_code = 'USD')::int as mrr_minor_usd,
        -- Prepaid balances the org is holding against platform-funded ad spend.
        -- This is money we owe as media, not revenue, and it was previously
        -- invisible on the admin page — the outstanding exposure under MCC.
        (select coalesce(sum(balance_minor), 0) from wallets where currency_code = 'INR')::int as wallet_balance_minor_inr,
        (select coalesce(sum(balance_minor), 0) from wallets where currency_code = 'USD')::int as wallet_balance_minor_usd,
        (select count(*) from offer_cycles where status in ('prompted','answered','previewed'))::int as offers_awaiting_reply,
        (select count(*) from offer_cycles where status = 'approved' and period_month = date_trunc('month', now()))::int as offers_approved_this_month,
        (select count(*) from purchases where status in ('paid','producing'))::int as cinematic_awaiting_production,
        (select count(*) from purchases where status = 'delivered')::int as cinematic_delivered,
        (select count(*) from purchases where status = 'failed')::int as cinematic_failed_unrefunded,
        (select coalesce(sum(amount_minor),0) from purchases where currency_code = 'INR' and status in ('paid','producing','delivered'))::int as add_on_revenue_minor_inr,
        (select coalesce(sum(amount_minor),0) from purchases where currency_code = 'USD' and status in ('paid','producing','delivered'))::int as add_on_revenue_minor_usd
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
        // The split that says how much of the org's money is at risk.
        // platformFunded accounts spend from AdVault's payments account and are
        // recovered from wallets; customerFunded ones cost the org nothing.
        platformFundedAccounts: c.platform_funded_accounts,
        customerFundedAccounts: c.customer_funded_accounts,
        // The onboarding funnel's leak, and the second thing worth alerting on.
        // These advertisers finished signup, got an ad account, and then never
        // completed the Google billing step — so they can never launch and
        // nothing else in this envelope would reveal it. A number that grows
        // rather than drains means the invitation email or the billing deep
        // link is broken.
        billingLinkIncomplete: c.billing_link_incomplete,
        activeSessions: c.active_sessions,
        // Revenue. `payingSubscribers` is the single number that says whether
        // this product is a business yet — it was structurally 0 before
        // subscriptions existed, and nothing on the admin page said so.
        payingSubscribers: c.paying_subscribers,
        pastDueSubscribers: c.past_due_subscribers,
        mrrMinorInr: c.mrr_minor_inr,
        mrrMinorUsd: c.mrr_minor_usd,
        // Prepaid ad balances held on behalf of platform-funded advertisers.
        // Money owed as media, not revenue — and the org's outstanding exposure
        // under the MCC, which had no representation here at all.
        walletBalanceMinorInr: c.wallet_balance_minor_inr,
        walletBalanceMinorUsd: c.wallet_balance_minor_usd,
        // The offer loop's health. Awaiting-reply climbing while approved stays
        // flat means the WhatsApp conversation is going out and landing nowhere,
        // which no other number here would show.
        offersAwaitingReply: c.offers_awaiting_reply,
        offersApprovedThisMonth: c.offers_approved_this_month,
        cinematicAwaitingProduction: c.cinematic_awaiting_production,
        cinematicDelivered: c.cinematic_delivered,
        // Paid for, production exhausted its retries, nothing delivered. This
        // is the only number here that is a REFUND QUEUE rather than a
        // statistic, and nothing else in the system will notice it — a value
        // above zero means someone is owed money back right now.
        cinematicFailedUnrefunded: c.cinematic_failed_unrefunded,
        addOnRevenueMinorInr: c.add_on_revenue_minor_inr,
        addOnRevenueMinorUsd: c.add_on_revenue_minor_usd,
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

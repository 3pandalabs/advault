import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { requireAdminOrAnalyticsToken } from "../auth/adminAccess.js";
import { SEGMENTS, segmentOf, type Segment } from "../lib/insights/policy.js";
import { formatMinor, type Currency } from "../lib/pricing/index.js";
import { WINDOW_DAYS, assess, dailyBurn } from "../lib/vendors/balancePolicy.js";

// The admin Business page (web /dashboard/admin/business): customers, the
// signup -> launch funnel, customer groups, categories, revenue and top ads.
// Read-only and DB-only. Customers = advertisers that are not deleted; admins
// are left out so our own testing doesn't count as customers.

type CustomerRow = {
  id: string;
  email: string;
  business_name: string | null;
  business_category: string | null;
  created_at: Date;
  photos: number;
  campaigns: number;
  ads_made: number;
  paid_ads: number;
  launched: number;
  live_now: number;
  active_months_90d: number;
  last_activity_at: Date | null;
  views: number;
  revenue_minor: number;
  currency_code: string;
};

// Revenue rows: paid ads/add-ons (purchases past "paid", amount > 0) and paid
// subscription invoices.
const PAID_PURCHASE = sql`p.status in ('paid','producing','delivered') and p.amount_minor > 0`;

export async function adminInsightsRoutes(app: FastifyInstance) {
  app.get("/admin/business", { preHandler: requireAdminOrAnalyticsToken }, async () => {
    const now = new Date();

    const customers = (
      await db.execute<CustomerRow>(sql`
        select
          u.id, u.email, u.business_name, u.business_category, u.created_at, u.currency_code,
          (select count(*)::int from assets a where a.user_id = u.id and a.kind = 'photo') as photos,
          (select count(*)::int from campaigns c where c.user_id = u.id) as campaigns,
          (select count(*)::int from creatives cr join campaigns c on c.id = cr.campaign_id
             where c.user_id = u.id and cr.render_status = 'ready') as ads_made,
          (select count(*)::int from purchases p where p.user_id = u.id and p.sku = 'new_ad' and ${PAID_PURCHASE}) as paid_ads,
          (select count(*)::int from campaigns c where c.user_id = u.id and c.launched_at is not null) as launched,
          (select count(*)::int from campaigns c where c.user_id = u.id and c.status = 'live') as live_now,
          (select count(distinct m)::int from (
              select date_trunc('month', p.created_at) m from purchases p
                where p.user_id = u.id and ${PAID_PURCHASE} and p.created_at > now() - interval '90 days'
              union select date_trunc('month', i.paid_at) from subscription_invoices i
                where i.user_id = u.id and i.status = 'paid' and i.paid_at > now() - interval '90 days'
              union select date_trunc('month', c.launched_at) from campaigns c
                where c.user_id = u.id and c.launched_at > now() - interval '90 days'
            ) months) as active_months_90d,
          greatest(
            (select max(a.created_at) from assets a where a.user_id = u.id),
            (select max(c.updated_at) from campaigns c where c.user_id = u.id),
            (select max(p.created_at) from purchases p where p.user_id = u.id)
          ) as last_activity_at,
          coalesce((select sum(m.views)::bigint from campaign_daily_metrics m join campaigns c on c.id = m.campaign_id
             where c.user_id = u.id), 0)::int as views,
          coalesce((select sum(p.amount_minor) from purchases p where p.user_id = u.id and ${PAID_PURCHASE}), 0)::int
            + coalesce((select sum(i.amount_minor) from subscription_invoices i where i.user_id = u.id and i.status = 'paid'), 0)::int
            as revenue_minor
        from users u
        where u.role = 'advertiser' and u.deleted_at is null
        order by u.created_at desc
      `)
    ).rows;

    const list = customers.map((c) => {
      const segment = segmentOf(
        {
          createdAt: new Date(c.created_at),
          photos: c.photos,
          campaigns: c.campaigns,
          adsMade: c.ads_made,
          paidAds: c.paid_ads,
          launched: c.launched,
          liveNow: c.live_now,
          activeMonths90d: c.active_months_90d,
          lastActivityAt: c.last_activity_at ? new Date(c.last_activity_at) : null,
        },
        now,
      );
      return {
        id: c.id,
        email: c.email,
        businessName: c.business_name,
        category: c.business_category,
        createdAt: c.created_at,
        segment,
        photos: c.photos,
        campaigns: c.campaigns,
        adsMade: c.ads_made,
        paidAds: c.paid_ads,
        launched: c.launched,
        liveNow: c.live_now,
        views: Number(c.views),
        revenueDisplay: formatMinor(c.revenue_minor, c.currency_code as Currency),
        lastActivityAt: c.last_activity_at,
      };
    });

    const day = 86_400_000;
    const since = (d: number) => list.filter((c) => now.getTime() - new Date(c.createdAt).getTime() <= d * day).length;
    const segments = (Object.keys(SEGMENTS) as Segment[]).map((key) => ({
      key,
      ...SEGMENTS[key],
      count: list.filter((c) => c.segment === key).length,
    }));

    const funnel = [
      { step: "Signed up", count: list.length },
      { step: "Uploaded photos", count: list.filter((c) => c.photos > 0).length },
      { step: "Paid for an ad", count: list.filter((c) => c.paidAds > 0).length },
      { step: "Ad made", count: list.filter((c) => c.adsMade > 0).length },
      { step: "Launched", count: list.filter((c) => c.launched > 0).length },
      { step: "Live now", count: list.filter((c) => c.liveNow > 0).length },
    ];

    const categories = (
      await db.execute<{
        category: string;
        customers: number;
        campaigns: number;
        ads_made: number;
        launched: number;
        views: number;
      }>(sql`
        select c.business_category as category,
          count(distinct c.user_id)::int as customers,
          count(*)::int as campaigns,
          coalesce(sum((select count(*) from creatives cr where cr.campaign_id = c.id and cr.render_status = 'ready')), 0)::int as ads_made,
          count(c.launched_at)::int as launched,
          coalesce(sum((select sum(m.views) from campaign_daily_metrics m where m.campaign_id = c.id)), 0)::bigint as views
        from campaigns c join users u on u.id = c.user_id
        where u.role = 'advertiser' and u.deleted_at is null
        group by c.business_category
        order by customers desc, campaigns desc
      `)
    ).rows.map((r) => ({ ...r, views: Number(r.views) }));

    const revenue = (
      await db.execute<{ source: string; currency_code: string; last30: number; all_time: number; count: number }>(sql`
        select source, currency_code, sum(last30)::int as last30, sum(amount)::int as all_time, count(*)::int as count from (
          select case p.sku when 'new_ad' then 'Ads ($10 each)' when 'cinematic' then 'Cinematic' else p.sku end as source,
            p.currency_code, p.amount_minor as amount,
            case when p.created_at > now() - interval '30 days' then p.amount_minor else 0 end as last30
          from purchases p join users u on u.id = p.user_id
          where ${PAID_PURCHASE} and u.role = 'advertiser'
          union all
          select 'Subscriptions', i.currency_code, i.amount_minor,
            case when i.paid_at > now() - interval '30 days' then i.amount_minor else 0 end
          from subscription_invoices i join users u on u.id = i.user_id
          where i.status = 'paid' and u.role = 'advertiser'
        ) r group by source, currency_code order by all_time desc
      `)
    ).rows.map((r) => ({
      source: r.source,
      currency: r.currency_code,
      count: r.count,
      last30Display: formatMinor(r.last30, r.currency_code as Currency),
      allTimeDisplay: formatMinor(r.all_time, r.currency_code as Currency),
    }));

    const topAds = (
      await db.execute<{
        campaign_id: string;
        business_name: string;
        category: string;
        email: string;
        status: string;
        views: number;
        impressions: number;
        clicks: number;
        cost_micros: number;
      }>(sql`
        select c.id as campaign_id, c.business_name, c.business_category as category, u.email, c.status,
          sum(m.views)::bigint as views, sum(m.impressions)::bigint as impressions,
          sum(m.clicks)::bigint as clicks, sum(m.cost_micros)::bigint as cost_micros
        from campaign_daily_metrics m join campaigns c on c.id = m.campaign_id join users u on u.id = c.user_id
        group by c.id, u.email
        having sum(m.views) > 0
        order by sum(m.views) desc
        limit 10
      `)
    ).rows.map((r) => {
      const views = Number(r.views);
      const impressions = Number(r.impressions);
      return {
        campaignId: r.campaign_id,
        businessName: r.business_name,
        category: r.category,
        email: r.email,
        status: r.status,
        views,
        clicks: Number(r.clicks),
        viewRate: impressions > 0 ? views / impressions : null,
        costPerView: views > 0 ? Number(r.cost_micros) / 1e6 / views : null,
      };
    });

    // fal credit (render/falBalanceWatch.ts readings): balance, spend rate,
    // the dynamic alert line and days left. Null until the first reading.
    const falRows = (
      await db.execute<{ balance_micros: number; taken_at: Date }>(sql`
        select balance_micros, taken_at from vendor_balance_snapshots
        where vendor = 'fal' and taken_at > now() - make_interval(days => ${WINDOW_DAYS})
        order by taken_at desc
      `)
    ).rows;
    const fal = falRows.length
      ? {
          balance: Number(falRows[0].balance_micros) / 1e6,
          checkedAt: falRows[0].taken_at,
          ...assess(
            Number(falRows[0].balance_micros) / 1e6,
            dailyBurn(falRows.map((r) => ({ balance: Number(r.balance_micros) / 1e6, at: new Date(r.taken_at) })), now),
          ),
        }
      : null;

    return {
      generatedAt: now.toISOString(),
      fal,
      totals: {
        customers: list.length,
        signups7d: since(7),
        signups30d: since(30),
        liveNow: funnel[5].count,
        adsMade: list.reduce((s, c) => s + c.adsMade, 0),
        totalViews: list.reduce((s, c) => s + c.views, 0),
      },
      funnel,
      segments,
      categories,
      revenue,
      topAds,
      customers: list,
    };
  });
}

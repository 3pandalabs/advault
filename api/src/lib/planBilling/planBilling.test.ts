// The $19 plan follows the running ad (2026-11-19): first month included once,
// stop at period end when no ad runs, un-stop inside the period, restart with
// the saved card after it, the Stripe webhook's first-payment duplicate, and
// the pause / resume routes. PGlite; Stripe and Google mocked.
import { createHmac } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../../db/schema.js";

const holder = vi.hoisted(() => {
  const dummy: Record<string, string> = {
    DATABASE_URL: "postgres://unused@localhost/unused",
    JWT_SECRET: "test-jwt-secret-test-jwt-secret-0000",
    R2_ACCOUNT_ID: "x",
    R2_ACCESS_KEY_ID: "x",
    R2_SECRET_ACCESS_KEY: "x",
    R2_BUCKET: "x",
    R2_ENDPOINT: "https://r2.invalid",
    TOKEN_ENCRYPTION_KEY: "0".repeat(64),
    METRICS_TOKEN: "metrics-token-for-tests",
    STRIPE_SECRET_KEY: "rk_test_x",
    STRIPE_WEBHOOK_SECRET: "whsec_test_plan",
    STRIPE_PRICE_US_EVERGREEN: "price_evergreen",
  };
  for (const [k, v] of Object.entries(dummy)) process.env[k] ??= v;
  return {
    db: null as unknown,
    setCancel: vi.fn(async (_ref: string, cancel: boolean) => ({ status: "active", cancel_at_period_end: cancel })),
    restart: vi.fn(async (_args: Record<string, unknown>): Promise<Record<string, unknown>> => ({
      ok: true,
      subscriptionRef: "sub_2",
      customerRef: "cus_1",
      invoiceRef: "in_2",
      amountPaidMinor: 5500,
    })),
    createCheckout: vi.fn(async (_req: Record<string, unknown>) => ({
      redirectUrl: "https://checkout.invalid",
      clientPayload: {},
      providerRef: `cs_${Math.random().toString(36).slice(2)}`,
    })),
    pause: vi.fn(async () => undefined),
    enable: vi.fn(async () => undefined),
  };
});

vi.mock("../../db/index.js", () => ({
  get db() {
    return holder.db;
  },
}));

vi.mock("../../auth/plugin.js", () => ({
  requireAuth: async (req: FastifyRequest, reply: FastifyReply) => {
    const id = req.headers["x-test-user"];
    if (typeof id !== "string") return reply.code(401).send({ error: "unauthorized" });
    (req as FastifyRequest & { userId?: string }).userId = id;
    req.userRole = "advertiser";
  },
  requireAdmin: async (_req: FastifyRequest, reply: FastifyReply) => {
    reply.code(403).send({ error: "admin_role_required" });
  },
}));

vi.mock("../subscriptions/providers/stripe.js", async (orig) => {
  const real = await orig<typeof import("../subscriptions/providers/stripe.js")>();
  return {
    ...real,
    stripeSubscriptions: { ...real.stripeSubscriptions, isConfigured: () => true, createCheckout: holder.createCheckout },
    stripeSetCancelAtPeriodEnd: holder.setCancel,
    stripeRestartOffSession: holder.restart,
    stripeSessionRefs: vi.fn(async () => ({ subscription: null, customer: null })),
    stripeCancelNow: vi.fn(async () => undefined),
    stripeExpireSession: vi.fn(async () => undefined),
  };
});

vi.mock("../googleAds/mcc.js", async (orig) => ({
  ...(await orig<typeof import("../googleAds/mcc.js")>()),
  isMccConfigured: () => true,
  mccAccessToken: async () => "token",
  pauseCampaign: holder.pause,
  enableCampaign: holder.enable,
}));

vi.mock("../billing/managedCard.js", async (orig) => ({
  ...(await orig<typeof import("../billing/managedCard.js")>()),
  syncCardLimit: async () => undefined,
}));

vi.mock("../ops/notify.js", () => ({ notifyOps: async () => true, isOpsNotifyConfigured: () => false }));

let app: FastifyInstance;
let pg: PGlite;
let plan: typeof import("./index.js");

async function newUser(email: string, role = "advertiser", extra = ""): Promise<string> {
  const r = await pg.query<{ id: string }>(
    `insert into users (email, password_hash, role) values ($1, 'x', $2) returning id`,
    [email, role],
  );
  const id = r.rows[0]!.id;
  if (extra) await pg.query(`update users set ${extra} where id = $1`, [id]);
  return id;
}

async function account(userId: string): Promise<string> {
  const a = await pg.query<{ id: string }>(
    `insert into ad_accounts (user_id, provider, customer_id, currency_code, is_managed, billing_mode, billing_link_status,
       login_customer_id, manager_customer_id, status, provision_status)
     values ($1, 'google_ads', '1234567890', 'USD', true, 'platform', 'active', '999', '999', 'active', 'active') returning id`,
    [userId],
  );
  return a.rows[0]!.id;
}

async function campaign(userId: string, accountId: string, status: string, endsOn: string | null = null): Promise<string> {
  const r = await pg.query<{ id: string }>(
    `insert into campaigns (user_id, name, business_name, business_category, target_zip_codes, daily_budget_cents,
       currency_code, landing_url, status, ad_account_id, google_campaign_resource_name, google_customer_id, ends_on)
     values ($1, 'c', 'Joe', 'Plumbing', '{10001}', 500, 'USD', 'https://example.com', $2, $3,
       'customers/1234567890/campaigns/1', '1234567890', $4) returning id`,
    [userId, status, accountId, endsOn],
  );
  return r.rows[0]!.id;
}

function sign(body: string): string {
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", "whsec_test_plan").update(`${t}.${body}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

async function webhook(event: Record<string, unknown>) {
  const body = JSON.stringify(event);
  return app.inject({
    method: "POST",
    url: "/webhooks/subscriptions/stripe",
    payload: body,
    headers: { "content-type": "application/json", "stripe-signature": sign(body) },
  });
}

async function subRows(userId: string) {
  return (
    await pg.query<{
      id: string;
      status: string;
      cancel_at_period_end: boolean;
      amount_minor: number;
      first_month_included: boolean;
      provider_subscription_ref: string | null;
      current_period_end: Date;
    }>(`select * from subscriptions where user_id = $1 order by created_at`, [userId])
  ).rows;
}

async function invoices(userId: string) {
  return (
    await pg.query<{ id: string; amount_minor: number; status: string; external_ref: string | null }>(
      `select * from subscription_invoices where user_id = $1 order by created_at, period_start`,
      [userId],
    )
  ).rows;
}

const flush = () => new Promise((r) => setTimeout(r, 30));

beforeAll(async () => {
  pg = new PGlite();
  const dir = join(__dirname, "../../../drizzle");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    await pg.exec(readFileSync(join(dir, f), "utf8").replaceAll("--> statement-breakpoint", ""));
  }
  holder.db = drizzle(pg, { schema });
  plan = await import("./index.js");

  const { subscriptionRoutes } = await import("../../routes/subscriptions.js");
  const { campaignRunStateRoutes } = await import("../../routes/campaignRunState.js");
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body: string, done) => {
    if ((req.routeOptions?.config as { rawBody?: boolean } | undefined)?.rawBody) {
      (req as unknown as { rawBody: string }).rawBody = body;
    }
    done(null, body.length ? JSON.parse(body) : undefined);
  });
  await app.register(subscriptionRoutes);
  await app.register(campaignRunStateRoutes);
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
});

beforeEach(() => {
  holder.setCancel.mockClear();
  holder.restart.mockClear();
  holder.createCheckout.mockClear();
  holder.pause.mockClear();
  holder.enable.mockClear();
});

/** A new customer who starts the plan with the included month and pays it ($0) via the webhook. */
async function startIncluded(email: string) {
  const userId = await newUser(email);
  const accountId = await account(userId);
  const campaignId = await campaign(userId, accountId, "ready");
  const res = await app.inject({
    method: "POST",
    url: "/subscription",
    headers: { "x-test-user": userId },
    payload: { planKey: "us-evergreen", campaignId },
  });
  expect(res.statusCode).toBe(201);
  const { subscriptionId, invoiceId } = res.json() as { subscriptionId: string; invoiceId: string };
  const done = await webhook({
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_first",
        mode: "subscription",
        amount_total: 0,
        currency: "usd",
        subscription: "sub_1",
        customer: "cus_1",
        metadata: { subscription_id: subscriptionId, invoice_id: invoiceId, app: "advault" },
      },
    },
  });
  expect(done.statusCode).toBe(200);
  await flush();
  return { userId, accountId, campaignId, subscriptionId, invoiceId };
}

describe("first month included", () => {
  it("a new customer must start the plan, at $0 today, to launch", async () => {
    const userId = await newUser("new@x.test");
    expect(await plan.planGateFor(userId)).toEqual({ ok: false, error: "plan_required", firstMonthIncluded: true });
  });

  it("the checkout is a Stripe trial to the end of the included month, returning to the campaign", async () => {
    const userId = await newUser("trial@x.test");
    const accountId = await account(userId);
    const campaignId = await campaign(userId, accountId, "ready");
    const res = await app.inject({
      method: "POST",
      url: "/subscription",
      headers: { "x-test-user": userId },
      payload: { planKey: "us-evergreen", campaignId },
    });
    expect(res.json()).toMatchObject({ firstMonthIncluded: true });
    const req = holder.createCheckout.mock.calls[0]![0] as { trialEnd: Date; returnUrl: string; amountMinor: number };
    expect(req).toMatchObject({ amountMinor: 2000, budgetMinor: 3500 });
    expect(req.returnUrl.endsWith(`/dashboard/campaigns/${campaignId}`)).toBe(true);
    const days = (req.trialEnd.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(27);
    expect(days).toBeLessThan(32);
    expect((await invoices(userId))[0]!.amount_minor).toBe(0);

    // Abandoned and reopened: the pending row is replaced, not a 409 for ever.
    const again = await app.inject({
      method: "POST",
      url: "/subscription",
      headers: { "x-test-user": userId },
      payload: { planKey: "us-evergreen" },
    });
    expect(again.statusCode).toBe(201);
    expect((await subRows(userId)).map((s) => s.status)).toEqual(["canceled", "pending"]);
  });

  it("paying the $0 month uses the credit once, posts no ledger rows, and the duplicate invoice.paid is not month two", async () => {
    const { userId, subscriptionId, invoiceId } = await startIncluded("used@x.test");
    const [s] = await subRows(userId);
    expect(s).toMatchObject({ status: "active", first_month_included: true, provider_subscription_ref: "sub_1" });
    const used = await pg.query(`select plan_first_month_used_at from users where id = $1`, [userId]);
    expect(used.rows[0]).toMatchObject({ plan_first_month_used_at: expect.any(Date) });
    const ledger = await pg.query(`select count(*)::int as n from ledger_entries where external_ref like 'subinv:%'`);
    expect((ledger.rows[0] as { n: number }).n).toBe(0);

    const dup = await webhook({
      type: "invoice.paid",
      data: {
        object: {
          id: "in_first",
          billing_reason: "subscription_create",
          amount_paid: 0,
          currency: "usd",
          subscription: "sub_1",
          customer: "cus_1",
          subscription_details: { metadata: { subscription_id: subscriptionId, invoice_id: invoiceId, app: "advault" } },
        },
      },
    });
    expect(dup.json()).toMatchObject({ alreadyApplied: true });
    expect(await invoices(userId)).toHaveLength(1);

    // A later plan is never free again.
    expect(await plan.firstMonthAvailable(userId)).toBe(false);
  });

  it("the first $20 + $35 after the included month lands as the next period (renewal path intact)", async () => {
    const { userId, subscriptionId, invoiceId } = await startIncluded("renew@x.test");
    const res = await webhook({
      type: "invoice.paid",
      data: {
        object: {
          id: "in_cycle_1",
          billing_reason: "subscription_cycle",
          amount_paid: 5500,
          currency: "usd",
          subscription: "sub_1",
          subscription_details: { metadata: { subscription_id: subscriptionId, invoice_id: invoiceId, app: "advault" } },
        },
      },
    });
    expect(res.json()).toMatchObject({ ok: true, alreadyApplied: false });
    const inv = await invoices(userId);
    expect(inv.map((i) => [i.amount_minor, i.status])).toEqual([
      [0, "paid"],
      [2000, "paid"],
    ]);
  });
});

describe("$55 a month: the monthly $35 ad budget recharge", () => {
  const cycle = (id: string, amount: number, subscriptionId: string, invoiceId: string) =>
    webhook({
      type: "invoice.paid",
      data: {
        object: {
          id,
          billing_reason: "subscription_cycle",
          amount_paid: amount,
          currency: "usd",
          subscription: "sub_1",
          subscription_details: { metadata: { subscription_id: subscriptionId, invoice_id: invoiceId, app: "advault" } },
        },
      },
    });
  const wallet = async (userId: string) =>
    (await pg.query<{ balance_minor: number }>(`select balance_minor from wallets where user_id = $1`, [userId])).rows[0]?.balance_minor ?? 0;
  const budgetRows = async (userId: string) =>
    (
      await pg.query<{ n: number }>(
        `select count(*)::int as n from ledger_entries where external_ref like 'subinv:%:budget' and wallet_id in (select id from wallets where user_id = $1)`,
        [userId],
      )
    ).rows[0]!.n;

  it("a new plan records $20 + $35 a month; the included month charges neither", async () => {
    const { userId } = await startIncluded("terms@x.test");
    const [s] = await pg.query<{ amount_minor: number; budget_recharge_minor: number }>(
      `select amount_minor, budget_recharge_minor from subscriptions where user_id = $1`,
      [userId],
    ).then((r) => r.rows);
    expect(s).toEqual({ amount_minor: 2000, budget_recharge_minor: 3500 });
    const [first] = await pg.query<{ amount_minor: number; budget_minor: number }>(
      `select amount_minor, budget_minor from subscription_invoices where user_id = $1`,
      [userId],
    ).then((r) => r.rows);
    expect(first).toEqual({ amount_minor: 0, budget_minor: 0 });
    expect(await budgetRows(userId)).toBe(0);
  });

  it("each paid month credits $35 to the ad budget exactly once per invoice, whatever replays", async () => {
    const { userId, subscriptionId, invoiceId } = await startIncluded("recharge@x.test");
    const before = await wallet(userId);
    expect((await cycle("in_c1", 5500, subscriptionId, invoiceId)).json()).toMatchObject({ alreadyApplied: false, budgetCreditedMinor: 3500 });
    expect(await wallet(userId)).toBe(before + 3500);
    // Stripe retries the same event: a duplicate, no second $35.
    expect((await cycle("in_c1", 5500, subscriptionId, invoiceId)).json()).toMatchObject({ alreadyApplied: true });
    expect(await wallet(userId)).toBe(before + 3500);
    expect(await budgetRows(userId)).toBe(1);
    // Even marking the same invoice paid again directly (a crash-retry) adds nothing.
    const paidId = (await invoices(userId)).at(-1)!.id;
    expect(await (await import("../subscriptions/index.js")).markInvoicePaid({ invoiceId: paidId, externalRef: "stripe:in_c1" })).toMatchObject({
      alreadyApplied: true,
      budgetCreditedMinor: 0,
    });
    // The next month is its own invoice: one more $35.
    expect((await cycle("in_c2", 5500, subscriptionId, invoiceId)).json()).toMatchObject({ budgetCreditedMinor: 3500 });
    expect(await wallet(userId)).toBe(before + 7000);
    expect(await budgetRows(userId)).toBe(2);
    // The fee is still exactly the $20 (the budget is never revenue).
    const fees = await pg.query<{ s: number }>(
      `select coalesce(sum(amount_minor), 0)::int as s from ledger_entries where type = 'fee' and wallet_id in (select id from wallets where user_id = $1)`,
      [userId],
    );
    expect(fees.rows[0]!.s).toBe(-4000);
  });

  it("a charge for the fee alone (no budget) is refused as a mismatch", async () => {
    const { userId, subscriptionId, invoiceId } = await startIncluded("mismatch@x.test");
    const res = await cycle("in_bad", 2000, subscriptionId, invoiceId);
    expect(res.statusCode).toBe(409);
    expect(await budgetRows(userId)).toBe(0);
  });

  it("an ad paused only because its budget ran out keeps a recharging plan going (the recharge restarts it)", async () => {
    const { userId, accountId } = await startIncluded("waiting@x.test");
    const id = await campaign(userId, accountId, "live");
    await plan.syncPlanBillingForUser(userId);
    await pg.query(`update campaigns set status = 'paused', paused_for_funds_at = now() where id = $1`, [id]);
    expect(await plan.syncPlanBillingForUser(userId)).toMatchObject({ action: "none", reason: "running_and_billing" });
    expect((await subRows(userId))[0]!.cancel_at_period_end).toBe(false);
    // The customer's own pause is a real pause: no fee, no recharge.
    await pg.query(`update campaigns set paused_for_funds_at = null where id = $1`, [id]);
    expect(await plan.syncPlanBillingForUser(userId)).toMatchObject({ action: "stop_at_period_end", ok: true });
  });
});

describe("$55 a month: existing $19 subscribers are grandfathered", () => {
  /** An account that paid the old $19 plan, now ended. */
  async function legacy(email: string) {
    const userId = await newUser(email, "advertiser", "plan_first_month_used_at = now()");
    const accountId = await account(userId);
    const s = await pg.query<{ id: string }>(
      `insert into subscriptions (user_id, plan_key, line, currency_code, amount_minor, provider, status, provider_ref,
         provider_subscription_ref, provider_customer_ref, current_period_start, current_period_end)
       values ($1, 'us-evergreen', 'evergreen', 'USD', 1900, 'stripe', 'canceled', $2, $2, 'cus_old',
         now() - interval '40 days', now() - interval '10 days') returning id`,
      [userId, email.startsWith("gf-restart") ? "sub_old" : `sub_old_${email}`],
    );
    await pg.query(
      `insert into subscription_invoices (subscription_id, user_id, amount_minor, currency_code, period_start, period_end, status, external_ref)
       values ($1, $2, 1900, 'USD', now() - interval '40 days', now() - interval '10 days', 'paid', 'stripe:in_old')`,
      [s.rows[0]!.id, userId],
    );
    await pg.query(`insert into wallets (user_id, currency_code, balance_minor) values ($1, 'USD', 10000)`, [userId]);
    return { userId, accountId };
  }

  it("a restart keeps $19 and adds no recharge", async () => {
    const { userId, accountId } = await legacy("gf-restart@x.test");
    const id = await campaign(userId, accountId, "paused");
    holder.restart.mockResolvedValueOnce({ ok: true, subscriptionRef: "sub_gf", customerRef: "cus_old", invoiceRef: "in_gf", amountPaidMinor: 1900 });
    const res = await app.inject({ method: "POST", url: `/campaigns/${id}/resume`, headers: { "x-test-user": userId } });
    expect(res.json()).toMatchObject({ planRestarted: true });
    expect(holder.restart.mock.calls[0]![0]).toMatchObject({ previousSubscriptionRef: "sub_old", amountMinor: 1900, budgetMinor: 0 });
    const subs = await pg.query<{ amount_minor: number; budget_recharge_minor: number }>(
      `select amount_minor, budget_recharge_minor from subscriptions where user_id = $1 and status = 'active'`,
      [userId],
    );
    expect(subs.rows).toEqual([{ amount_minor: 1900, budget_recharge_minor: 0 }]);
    expect((await invoices(userId)).at(-1)).toMatchObject({ amount_minor: 1900, budget_minor: 0, status: "paid" });
  });

  it("a new checkout keeps $19 and adds no recharge", async () => {
    const { userId } = await legacy("gf-checkout@x.test");
    const res = await app.inject({ method: "POST", url: "/subscription", headers: { "x-test-user": userId }, payload: { planKey: "us-evergreen" } });
    expect(res.json()).toMatchObject({ amountMinor: 1900, budgetRechargeMinor: 0, firstMonthIncluded: false });
    expect(holder.createCheckout.mock.calls.at(-1)![0]).toMatchObject({ amountMinor: 1900, budgetMinor: 0 });
  });

  it("an existing live $19 subscription is never repriced: renewals stay $19 with no budget", async () => {
    const userId = await newUser("gf-live@x.test", "advertiser", "plan_first_month_used_at = now()");
    const s = await pg.query<{ id: string }>(
      `insert into subscriptions (user_id, plan_key, line, currency_code, amount_minor, provider, status, current_period_start, current_period_end)
       values ($1, 'us-evergreen', 'evergreen', 'USD', 1900, 'stripe', 'active', now() - interval '31 days', now() - interval '1 day') returning id`,
      [userId],
    );
    const { openNextInvoice } = await import("../subscriptions/index.js");
    const next = await openNextInvoice(s.rows[0]!.id);
    expect(next!.invoice).toMatchObject({ amountMinor: 1900, budgetMinor: 0 });
  });
});

describe("billing follows running state", () => {
  it("stops at period end when no ad runs, idempotently, then un-cancels when one runs again", async () => {
    const { userId, accountId } = await startIncluded("follow@x.test");
    // The webhook's own sync already stopped it: nothing is running yet.
    expect((await subRows(userId))[0]!.cancel_at_period_end).toBe(true);
    expect(holder.setCancel).toHaveBeenCalledWith("sub_1", true);

    holder.setCancel.mockClear();
    expect(await plan.syncPlanBillingForUser(userId)).toMatchObject({ action: "none" });
    expect(holder.setCancel).not.toHaveBeenCalled();

    await campaign(userId, accountId, "live");
    expect(await plan.syncPlanBillingForUser(userId)).toMatchObject({ action: "uncancel", ok: true });
    expect(holder.setCancel).toHaveBeenCalledWith("sub_1", false);
    expect((await subRows(userId))[0]!.cancel_at_period_end).toBe(false);
    expect(holder.restart).not.toHaveBeenCalled();
  });

  it("an ad past its end date is not running", async () => {
    const { userId, accountId } = await startIncluded("ended@x.test");
    await campaign(userId, accountId, "live");
    await plan.syncPlanBillingForUser(userId);
    expect((await subRows(userId))[0]!.cancel_at_period_end).toBe(false);
    await pg.query(`update campaigns set ends_on = '2020-01-01' where user_id = $1`, [userId]);
    expect(await plan.syncPlanBillingForUser(userId)).toMatchObject({ action: "stop_at_period_end", ok: true });
  });

  it("pause stops the plan, resume inside the period un-stops it (no new charge)", async () => {
    const { userId, accountId } = await startIncluded("pause@x.test");
    const id = await campaign(userId, accountId, "live");
    await plan.syncPlanBillingForUser(userId);
    await pg.query(`insert into wallets (user_id, currency_code, balance_minor) values ($1, 'USD', 10000)`, [userId]);

    const paused = await app.inject({ method: "POST", url: `/campaigns/${id}/pause`, headers: { "x-test-user": userId } });
    expect(paused.statusCode).toBe(200);
    expect(paused.json()).toMatchObject({ campaign: { status: "paused" }, plan: { action: "stop_at_period_end" } });
    expect(holder.pause).toHaveBeenCalledOnce();

    const resumed = await app.inject({ method: "POST", url: `/campaigns/${id}/resume`, headers: { "x-test-user": userId } });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json()).toMatchObject({ campaign: { status: "live" }, plan: { action: "uncancel" }, planRestarted: false });
    expect(holder.restart).not.toHaveBeenCalled();
    expect(await invoices(userId)).toHaveLength(1);
  });

  it("resume after the paid period restarts the plan with the saved card (a new period, charged then)", async () => {
    const { userId, accountId } = await startIncluded("restart@x.test");
    const id = await campaign(userId, accountId, "paused");
    await pg.query(`insert into wallets (user_id, currency_code, balance_minor) values ($1, 'USD', 10000)`, [userId]);
    const [old] = await subRows(userId);
    // Stripe ended it at the period end.
    const gone = await webhook({
      type: "customer.subscription.deleted",
      data: { object: { id: "sub_1", metadata: { subscription_id: old!.id, app: "advault" } } },
    });
    expect(gone.statusCode).toBe(200);

    const resumed = await app.inject({ method: "POST", url: `/campaigns/${id}/resume`, headers: { "x-test-user": userId } });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json()).toMatchObject({ planRestarted: true });
    expect(holder.restart).toHaveBeenCalledOnce();
    expect(holder.restart.mock.calls[0]![0]).toMatchObject({ previousSubscriptionRef: "sub_1", amountMinor: 2000, budgetMinor: 3500, testMode: false });

    const subs = await subRows(userId);
    expect(subs.map((s) => s.status)).toEqual(["canceled", "active"]);
    expect(subs[1]).toMatchObject({ provider_subscription_ref: "sub_2", first_month_included: false, cancel_at_period_end: false });
    const inv = await invoices(userId);
    expect(inv.at(-1)).toMatchObject({ amount_minor: 2000, budget_minor: 3500, status: "paid", external_ref: "stripe:in_2" });
    const fee = await pg.query(`select count(*)::int as n from ledger_entries where type = 'fee' and amount_minor = -2000 and wallet_id in (select id from wallets where user_id = $1)`, [userId]);
    expect((fee.rows[0] as { n: number }).n).toBe(1);
    // A card charge: the fee nets to zero (paired credit + fee) and the
    // month's $35 ad budget lands in the wallet.
    const bal = await pg.query(`select balance_minor from wallets where user_id = $1`, [userId]);
    expect((bal.rows[0] as { balance_minor: number }).balance_minor).toBe(13500);

    // Stripe's own invoice.paid for the restart is a duplicate.
    const dup = await webhook({
      type: "invoice.paid",
      data: {
        object: {
          id: "in_2",
          billing_reason: "subscription_create",
          amount_paid: 5500,
          currency: "usd",
          subscription: "sub_2",
          subscription_details: { metadata: { subscription_id: subs[1]!.id, invoice_id: inv.at(-1)!.id, app: "advault" } },
        },
      },
    });
    expect(dup.json()).toMatchObject({ alreadyApplied: true });
  });

  it("a declined card sends the customer to checkout and leaves no live plan", async () => {
    const { userId, accountId } = await startIncluded("declined@x.test");
    const id = await campaign(userId, accountId, "paused");
    await pg.query(`insert into wallets (user_id, currency_code, balance_minor) values ($1, 'USD', 10000)`, [userId]);
    await pg.query(`update subscriptions set status = 'canceled' where user_id = $1`, [userId]);
    holder.restart.mockResolvedValueOnce({ ok: false, reason: "card_declined" });

    const resumed = await app.inject({ method: "POST", url: `/campaigns/${id}/resume`, headers: { "x-test-user": userId } });
    expect(resumed.statusCode).toBe(402);
    expect(resumed.json()).toMatchObject({ error: "plan_required", firstMonthIncluded: false });
    expect(holder.enable).not.toHaveBeenCalled();
    expect((await subRows(userId)).every((s) => s.status === "canceled")).toBe(true);

    // ...and that checkout charges $19 now: no second free month.
    await app.inject({ method: "POST", url: "/subscription", headers: { "x-test-user": userId }, payload: { planKey: "us-evergreen" } });
    expect((holder.createCheckout.mock.calls.at(-1)![0] as { trialEnd: Date | null }).trialEnd).toBeNull();
    expect((await invoices(userId)).at(-1)!.amount_minor).toBe(2000);
  });

  it("the customer cannot cancel the plan while an ad runs (pausing is how)", async () => {
    const { userId, accountId } = await startIncluded("nocancel@x.test");
    await campaign(userId, accountId, "live");
    const res = await app.inject({ method: "POST", url: "/subscription/cancel", headers: { "x-test-user": userId }, payload: {} });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("plan_follows_ads");
  });
});

describe("test mode, admins, at_cost", () => {
  it("an admin testing as a customer gets the same flow at the 50-cent test price", async () => {
    const userId = await newUser("admin-test@x.test", "admin", "test_as_customer = true");
    expect(await plan.planGateFor(userId)).toMatchObject({ error: "plan_required", firstMonthIncluded: true });
    await app.inject({ method: "POST", url: "/subscription", headers: { "x-test-user": userId }, payload: { planKey: "us-evergreen" } });
    const req = holder.createCheckout.mock.calls[0]![0] as { amountMinor: number; testMode: boolean; trialEnd: Date | null };
    expect(req).toMatchObject({ amountMinor: 50, budgetMinor: 50, testMode: true });
    expect(req.trialEnd).toBeInstanceOf(Date);
  });

  it("admins (not testing) and at_cost accounts pay no plan and are never synced", async () => {
    const admin = await newUser("admin@x.test", "admin");
    const atCost = await newUser("atcost@x.test", "advertiser", "margin_mode = 'at_cost'");
    for (const id of [admin, atCost]) {
      expect(await plan.planGateFor(id)).toEqual({ ok: true });
      const acc = await account(id);
      await campaign(id, acc, "live");
      expect(await plan.syncPlanBillingForUser(id)).toMatchObject({ action: "none", reason: "exempt" });
    }
    expect(holder.restart).not.toHaveBeenCalled();
  });
});

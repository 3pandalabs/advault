import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAdmin, requireAuth } from "../auth/plugin.js";
import { db } from "../db/index.js";
import { adAccounts, payments, users } from "../db/schema.js";
import { env } from "../env.js";
import { invoiceShapeFor } from "../lib/billing/policy.js";
import {
  applyEntry,
  DuplicateLedgerEntry,
  ensureWallet,
  getBalance,
  listEntries,
  sumEntriesByType,
} from "../lib/wallet/index.js";
import { providerByName, providerFor } from "../lib/payments/index.js";
import {
  effectiveMonthlyFeeMinor,
  estimateReach,
  formatMinor,
  isCurrency,
  monthlyQuoteMinor,
  planFor,
  type Currency,
} from "../lib/pricing/index.js";

export async function billingRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------
  // Public: pricing + the landing page calculator.
  //
  // Unauthenticated on purpose — the calculator is the top of the funnel and
  // must work before signup. It exposes only modelled arithmetic, no user data.
  // Registered before the auth hook below.
  // ---------------------------------------------------------------------
  app.get(
    "/pricing",
    { schema: { querystring: z.object({ currency: z.string().default("USD") }) } },
    async (req, reply) => {
      const { currency } = req.query as { currency: string };
      if (!isCurrency(currency)) return reply.code(400).send({ error: "unsupported_currency" });

      const offer = planFor(currency, "offer");
      const managed = planFor(currency, "managed");
      const shape = (p: typeof offer) => ({
        key: p.key,
        line: p.line,
        label: p.label,
        blurb: p.blurb,
        currency: p.currency,
        monthlyFeeMinor: p.monthlyFeeMinor,
        includedCreativesPerMonth: p.includedCreativesPerMonth,
        suggestedAdBudgetMinor: p.suggestedAdBudgetMinor,
        minDailyBudgetMinor: p.minDailyBudgetMinor,
        // The all-in figure a platform-billed advertiser is quoted. The offer
        // line buys no media, so its quote is the fee alone.
        monthlyQuoteMinor: monthlyQuoteMinor(p, {
          bundledAdBudgetMinor: p.suggestedAdBudgetMinor,
        }),
        reach:
          p.suggestedAdBudgetMinor > 0 ? estimateReach(p.suggestedAdBudgetMinor, p.currency) : null,
      });

      return { currency, plans: { offer: shape(offer), managed: shape(managed) } };
    },
  );

  app.get(
    "/pricing/estimate",
    {
      schema: {
        querystring: z.object({
          currency: z.string().default("USD"),
          adBudgetMinor: z.coerce.number().int().positive().max(100_000_000),
          marginMode: z.enum(["standard", "at_cost"]).default("standard"),
        }),
      },
    },
    async (req, reply) => {
      const q = req.query as { currency: string; adBudgetMinor: number; marginMode: "standard" | "at_cost" };
      if (!isCurrency(q.currency)) return reply.code(400).send({ error: "unsupported_currency" });

      // Always the managed plan: this endpoint exists for the budget slider,
      // and the offer line has no ad budget to estimate against.
      const plan = planFor(q.currency, "managed");
      const monthlyTotal = monthlyQuoteMinor(plan, {
        marginMode: q.marginMode,
        bundledAdBudgetMinor: q.adBudgetMinor,
      });
      return {
        currency: q.currency,
        adBudgetMinor: q.adBudgetMinor,
        monthlyFeeMinor: effectiveMonthlyFeeMinor(plan, q.marginMode),
        monthlyTotalMinor: monthlyTotal,
        // Modelled, and the UI must say so. A hard promise about someone's
        // specific neighbourhood is a claim we cannot back — same honesty
        // constraint as MealMargin's dataset.
        reach: estimateReach(q.adBudgetMinor, q.currency),
        display: {
          adBudget: formatMinor(q.adBudgetMinor, q.currency),
          monthlyTotal: formatMinor(monthlyTotal, q.currency),
        },
      };
    },
  );

  // ---------------------------------------------------------------------
  // Everything below requires a login.
  // ---------------------------------------------------------------------
  app.register(async (secured) => {
    secured.addHook("onRequest", requireAuth);

    secured.get("/wallet", async (req) => {
      const [user] = await db
        .select({ currencyCode: users.currencyCode })
        .from(users)
        .where(eq(users.id, req.userId!))
        .limit(1);

      const wallet = await ensureWallet(req.userId!, user.currencyCode as Currency);
      return {
        balanceMinor: wallet.balanceMinor,
        currencyCode: wallet.currencyCode,
        display: formatMinor(wallet.balanceMinor, wallet.currencyCode as Currency),
        entries: await listEntries(req.userId!),
      };
    });

    // ---------------------------------------------------------------------
    // Billing summary — the disclosure surface.
    //
    // Google's Third Party Policy requires a reseller to show clients their
    // ACTUAL ad costs, distinct from the reseller's own fee. That obligation
    // attaches to platform-funded accounts, where we pay Google and rebill:
    // a single blended figure does not satisfy it. Customer-funded advertisers
    // have no pass-through from us at all, so their summary carries no ad-spend
    // line — there isn't one to disclose.
    //
    // NOTE: AdVault has no invoice generation. This endpoint is the shape an
    // invoice would take, sourced from the ledger, and is what the dashboard
    // renders today.
    // ---------------------------------------------------------------------
    secured.get("/billing/summary", async (req) => {
      const [user] = await db
        .select({ currencyCode: users.currencyCode })
        .from(users)
        .where(eq(users.id, req.userId!))
        .limit(1);
      const currency = user.currencyCode as Currency;

      const accounts = await db
        .select({
          id: adAccounts.id,
          customerId: adAccounts.customerId,
          descriptiveName: adAccounts.descriptiveName,
          isManaged: adAccounts.isManaged,
          billingMode: adAccounts.billingMode,
          billingLinkStatus: adAccounts.billingLinkStatus,
        })
        .from(adAccounts)
        .where(and(eq(adAccounts.userId, req.userId!), eq(adAccounts.status, "active")));

      const anyPlatform = accounts.some((a) => a.billingMode === "platform");

      // Ledger totals by type. Only meaningful when something is platform
      // funded — a purely customer-funded advertiser never accrues spend rows.
      const totals = anyPlatform ? await sumEntriesByType(req.userId!) : {};
      const adSpendMinor = Math.abs(totals.spend ?? 0);
      const feeMinor = Math.abs(totals.fee ?? 0);

      return {
        currencyCode: currency,
        accounts: accounts.map((a) => ({
          ...a,
          invoiceShape: invoiceShapeFor(a.billingMode),
        })),
        // Present only when we actually fronted money. Omitted rather than
        // zeroed for customer-funded advertisers, so the dashboard can tell
        // "nothing yet" apart from "not applicable".
        passThrough: anyPlatform
          ? {
              adSpendMinor,
              display: formatMinor(adSpendMinor, currency),
              note: "Ad spend AdVault paid Google on your behalf.",
            }
          : null,
        fees: {
          feeMinor,
          display: formatMinor(feeMinor, currency),
          note: "AdVault's own charges.",
        },
      };
    });

    secured.post(
      "/wallet/topup",
      {
        schema: {
          body: z.object({
            amountMinor: z.number().int().positive().max(100_000_000),
            purpose: z.enum(["topup", "creation_fee"]).default("topup"),
          }),
        },
      },
      async (req, reply) => {
        const body = req.body as { amountMinor: number; purpose: "topup" | "creation_fee" };
        const [user] = await db
          .select({ email: users.email, currencyCode: users.currencyCode })
          .from(users)
          .where(eq(users.id, req.userId!))
          .limit(1);

        const currency = user.currencyCode as Currency;
        const provider = providerFor(currency);

        // The payments row is written BEFORE the provider is called, so its id
        // can be carried in provider metadata and come back on the webhook.
        // That id is the only reliable link between a verified event and a
        // wallet — never the amount or the user, neither of which is unique.
        const [payment] = await db
          .insert(payments)
          .values({
            userId: req.userId!,
            provider: provider.name,
            amountMinor: body.amountMinor,
            currencyCode: currency,
            purpose: body.purpose,
            status: "created",
          })
          .returning();

        try {
          const session = await provider.createCheckout({
            paymentId: payment.id,
            amountMinor: body.amountMinor,
            currency,
            purpose: body.purpose,
            userEmail: user.email,
            returnUrl: `${env.WEB_ORIGIN}/dashboard/wallet`,
          });

          await db
            .update(payments)
            .set({ providerRef: session.providerRef, updatedAt: new Date() })
            .where(eq(payments.id, payment.id));

          return reply.code(201).send({
            paymentId: payment.id,
            provider: provider.name,
            redirectUrl: session.redirectUrl,
            clientPayload: session.clientPayload,
          });
        } catch (err) {
          req.log.error({ err }, "checkout creation failed");
          await db
            .update(payments)
            .set({ status: "failed", updatedAt: new Date() })
            .where(eq(payments.id, payment.id));
          return reply.code(502).send({ error: "checkout_failed" });
        }
      },
    );

    // Admin-only manual credit. This is the ONLY way the manual provider can
    // ever move money — deliberately behind requireAdmin so that "no payment
    // provider configured" can never become "anyone can mint balance".
    secured.post(
      "/admin/wallet/credit",
      {
        preHandler: requireAdmin,
        schema: {
          body: z.object({
            userId: z.string().uuid(),
            amountMinor: z.number().int().positive(),
            reason: z.string().min(1).max(200),
          }),
        },
      },
      async (req) => {
        const body = req.body as { userId: string; amountMinor: number; reason: string };
        const [target] = await db
          .select({ currencyCode: users.currencyCode })
          .from(users)
          .where(eq(users.id, body.userId))
          .limit(1);

        const result = await applyEntry({
          userId: body.userId,
          currency: target.currencyCode as Currency,
          type: "adjustment",
          amountMinor: body.amountMinor,
          description: `Manual credit by admin: ${body.reason}`,
          externalRef: `admin:${Date.now()}:${body.userId}`,
        });
        return { balanceMinor: result.balanceMinor };
      },
    );
  });

  // ---------------------------------------------------------------------
  // Webhooks. Unauthenticated by necessity — the provider calls these, not a
  // logged-in user. The SIGNATURE is the authentication, which is why the raw
  // body is preserved: an HMAC over a re-serialised body never matches.
  // ---------------------------------------------------------------------
  app.post(
    "/webhooks/payments/:provider",
    {
      schema: { params: z.object({ provider: z.enum(["razorpay", "stripe"]) }) },
      config: { rawBody: true },
    },
    async (req, reply) => {
      const { provider: name } = req.params as { provider: string };
      const provider = providerByName(name);
      if (!provider) return reply.code(404).send({ error: "unknown_provider" });

      const raw = (req as { rawBody?: string }).rawBody;
      if (!raw) return reply.code(400).send({ error: "missing_raw_body" });

      const event = provider.verifyWebhook(raw, req.headers as Record<string, string | undefined>);
      // Verification failed: bad signature, stale timestamp, or unparseable.
      // 400 and nothing else — never log the body at info level, and never act
      // on it. An unverified "paid" event is free money.
      if (!event) {
        req.log.warn({ provider: name }, "rejected an unverified payment webhook");
        return reply.code(400).send({ error: "invalid_signature" });
      }

      const [payment] = await db
        .select()
        .from(payments)
        .where(eq(payments.id, event.paymentId))
        .limit(1);
      if (!payment) return reply.code(404).send({ error: "unknown_payment" });

      // Amount is taken from the PROVIDER's event, not our row — but a mismatch
      // means something is wrong enough to refuse rather than reconcile.
      if (event.amountMinor !== payment.amountMinor || event.currency !== payment.currencyCode) {
        req.log.error({ paymentId: payment.id }, "payment amount/currency mismatch");
        return reply.code(409).send({ error: "amount_mismatch" });
      }

      await db
        .update(payments)
        .set({
          status: event.status,
          providerRef: event.providerRef,
          providerPayload: event.raw as object,
          updatedAt: new Date(),
        })
        .where(eq(payments.id, payment.id));

      if (event.status !== "paid") return reply.code(200).send({ ok: true });

      try {
        await applyEntry({
          userId: payment.userId,
          currency: payment.currencyCode as Currency,
          type: payment.purpose === "topup" ? "topup" : "adjustment",
          amountMinor: payment.amountMinor,
          description:
            payment.purpose === "topup" ? "Ad balance top-up" : "Campaign creation fee payment",
          // Provider ref as the idempotency key. Both Razorpay and Stripe retry
          // webhooks by design; this is what stands between "the provider
          // retried" and "we credited them twice".
          externalRef: `${provider.name}:${event.providerRef}`,
        });
      } catch (err) {
        if (err instanceof DuplicateLedgerEntry) {
          // Already applied. 200 so the provider stops retrying.
          return reply.code(200).send({ ok: true, duplicate: true });
        }
        throw err;
      }

      return reply.code(200).send({ ok: true });
    },
  );
}

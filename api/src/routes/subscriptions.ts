import { and, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAdmin, requireAuth } from "../auth/plugin.js";
import { db } from "../db/index.js";
import { subscriptionInvoices, subscriptions, users } from "../db/schema.js";
import { env } from "../env.js";
import {
  AlreadySubscribed,
  cancelSubscription,
  createSubscription,
  liveSubscriptionFor,
  markInvoiceFailed,
  markInvoicePaid,
  NoSuchPlan,
  resolveInvoiceForPayment,
} from "../lib/subscriptions/index.js";
import { entitlesToService, type SubscriptionStatus } from "../lib/subscriptions/policy.js";
import {
  subscriptionProviderByName,
  subscriptionProviderFor,
} from "../lib/subscriptions/providers/index.js";
import {
  estimateReach,
  formatMinor,
  isCurrency,
  planByKey,
  PLANS,
  type Currency,
} from "../lib/pricing/index.js";

export async function subscriptionRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------
  // Public: the price card.
  //
  // Unauthenticated because it is the top of the funnel. It exposes the plan
  // list and modelled reach arithmetic, no user data.
  // ---------------------------------------------------------------------
  app.get(
    "/plans",
    { schema: { querystring: z.object({ currency: z.string().default("USD") }) } },
    async (req, reply) => {
      const { currency } = req.query as { currency: string };
      if (!isCurrency(currency)) return reply.code(400).send({ error: "unsupported_currency" });

      const plans = Object.values(PLANS)
        .filter((p) => p.currency === currency)
        .map((p) => ({
          key: p.key,
          line: p.line,
          label: p.label,
          blurb: p.blurb,
          currency: p.currency,
          monthlyFeeMinor: p.monthlyFeeMinor,
          includedCreativesPerMonth: p.includedCreativesPerMonth,
          suggestedAdBudgetMinor: p.suggestedAdBudgetMinor,
          minDailyBudgetMinor: p.minDailyBudgetMinor,
          display: {
            monthlyFee: formatMinor(p.monthlyFeeMinor, p.currency),
            // Platform-billed managed advertisers are quoted one all-in number
            // rather than a fee plus a budget. A ₹1,499 fee shown next to
            // ₹2,000 of spend invites the 75%-fee-ratio arithmetic that no
            // agency comparison survives.
            allIn:
              p.line === "managed"
                ? formatMinor(p.monthlyFeeMinor + p.suggestedAdBudgetMinor, p.currency)
                : formatMinor(p.monthlyFeeMinor, p.currency),
          },
          reach:
            p.suggestedAdBudgetMinor > 0
              ? estimateReach(p.suggestedAdBudgetMinor, p.currency)
              : null,
        }));

      return { currency, plans };
    },
  );

  // ---------------------------------------------------------------------
  // Authenticated subscription management.
  // ---------------------------------------------------------------------
  app.register(async (secured) => {
    secured.addHook("onRequest", requireAuth);

    secured.get("/subscription", async (req) => {
      const sub = await liveSubscriptionFor(req.userId!);
      if (!sub) return { subscription: null, entitled: false };

      const invoices = await db
        .select({
          id: subscriptionInvoices.id,
          amountMinor: subscriptionInvoices.amountMinor,
          currencyCode: subscriptionInvoices.currencyCode,
          periodStart: subscriptionInvoices.periodStart,
          periodEnd: subscriptionInvoices.periodEnd,
          status: subscriptionInvoices.status,
          paidAt: subscriptionInvoices.paidAt,
        })
        .from(subscriptionInvoices)
        .where(eq(subscriptionInvoices.subscriptionId, sub.id))
        .orderBy(desc(subscriptionInvoices.periodStart))
        .limit(24);

      return {
        subscription: {
          id: sub.id,
          planKey: sub.planKey,
          line: sub.line,
          status: sub.status,
          amountMinor: sub.amountMinor,
          currencyCode: sub.currencyCode,
          display: formatMinor(sub.amountMinor, sub.currencyCode as Currency),
          currentPeriodStart: sub.currentPeriodStart,
          currentPeriodEnd: sub.currentPeriodEnd,
          cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
          // past_due is deliberately still entitled — that is what the grace
          // window is. The UI shows a warning, not a lockout.
          pastDue: sub.status === "past_due",
        },
        entitled: entitlesToService(sub.status as SubscriptionStatus),
        invoices,
      };
    });

    secured.post(
      "/subscription",
      { schema: { body: z.object({ planKey: z.string().min(1).max(40) }) } },
      async (req, reply) => {
        const { planKey } = req.body as { planKey: string };
        const plan = planByKey(planKey);
        if (!plan) return reply.code(400).send({ error: "no_such_plan" });

        const [user] = await db
          .select({ email: users.email, currencyCode: users.currencyCode, marginMode: users.marginMode })
          .from(users)
          .where(eq(users.id, req.userId!))
          .limit(1);

        // The plan's currency must match the user's market. Subscribing a US
        // user to an INR plan would create a mandate their bank cannot honour
        // and a Google child account in the wrong, immutable currency.
        if (user.currencyCode !== plan.currency) {
          return reply.code(400).send({ error: "currency_mismatch" });
        }

        // at_cost is a 0%-margin growth mode. It gets no subscription row at
        // all rather than a zero-amount one, so counting rows answers "how many
        // people pay us" without a filter someone will forget.
        if (user.marginMode === "at_cost") {
          return reply.code(409).send({ error: "at_cost_account", message: "No fee is charged on this account." });
        }

        const provider = subscriptionProviderFor(plan.currency, plan.line);

        let created;
        try {
          created = await createSubscription({
            userId: req.userId!,
            planKey: plan.key,
            provider: provider.name,
          });
        } catch (err) {
          if (err instanceof AlreadySubscribed) {
            return reply.code(409).send({ error: "already_subscribed" });
          }
          if (err instanceof NoSuchPlan) return reply.code(400).send({ error: "no_such_plan" });
          throw err;
        }

        try {
          const checkout = await provider.createCheckout({
            subscriptionId: created.subscription.id,
            invoiceId: created.invoice.id,
            planKey: plan.key,
            amountMinor: plan.monthlyFeeMinor,
            currency: plan.currency,
            userEmail: user.email,
            returnUrl: `${env.WEB_ORIGIN}/dashboard/subscription`,
          });

          await db
            .update(subscriptions)
            .set({ providerRef: checkout.providerRef, updatedAt: new Date() })
            .where(eq(subscriptions.id, created.subscription.id));

          return reply.code(201).send({
            subscriptionId: created.subscription.id,
            invoiceId: created.invoice.id,
            provider: provider.name,
            redirectUrl: checkout.redirectUrl,
            clientPayload: checkout.clientPayload,
          });
        } catch (err) {
          req.log.error({ err }, "subscription checkout creation failed");
          // Roll the subscription out of the live set, or the partial unique
          // index blocks the customer from ever retrying.
          await db
            .update(subscriptions)
            .set({ status: "canceled", canceledAt: new Date(), updatedAt: new Date() })
            .where(eq(subscriptions.id, created.subscription.id));
          return reply.code(502).send({ error: "checkout_failed" });
        }
      },
    );

    secured.post(
      "/subscription/cancel",
      { schema: { body: z.object({ immediate: z.boolean().default(false) }) } },
      async (req, reply) => {
        const { immediate } = req.body as { immediate: boolean };
        const sub = await liveSubscriptionFor(req.userId!);
        if (!sub) return reply.code(404).send({ error: "no_subscription" });

        const updated = await cancelSubscription({ subscriptionId: sub.id, immediate });
        return {
          status: updated?.status,
          cancelAtPeriodEnd: updated?.cancelAtPeriodEnd,
          servesUntil: updated?.currentPeriodEnd,
        };
      },
    );

    // Admin-only. The ONLY way a manual-provider subscription can become paid —
    // same shape and same reasoning as the manual wallet credit: an operator
    // action with an audit trail, never an anonymous one.
    secured.post(
      "/admin/subscription/invoices/:invoiceId/mark-paid",
      {
        preHandler: requireAdmin,
        schema: { params: z.object({ invoiceId: z.string().uuid() }) },
      },
      async (req) => {
        const { invoiceId } = req.params as { invoiceId: string };
        const result = await markInvoicePaid({
          invoiceId,
          externalRef: `manual:${invoiceId}`,
          providerPayload: { markedBy: req.userId, at: new Date().toISOString() },
        });
        return { ok: true, ...result };
      },
    );
  });

  // ---------------------------------------------------------------------
  // Webhooks. Unauthenticated by necessity; the signature IS the auth.
  // ---------------------------------------------------------------------
  app.post(
    "/webhooks/subscriptions/:provider",
    {
      schema: { params: z.object({ provider: z.enum(["razorpay", "stripe", "paddle"]) }) },
      config: { rawBody: true },
    },
    async (req, reply) => {
      const { provider: name } = req.params as { provider: string };
      const provider = subscriptionProviderByName(name);
      if (!provider) return reply.code(404).send({ error: "unknown_provider" });

      const raw = (req as { rawBody?: string }).rawBody;
      if (!raw) return reply.code(400).send({ error: "missing_raw_body" });

      const event = provider.verifyWebhook(raw, req.headers as Record<string, string | undefined>);
      if (!event) {
        req.log.warn({ provider: name }, "rejected an unverified subscription webhook");
        return reply.code(400).send({ error: "invalid_signature" });
      }

      switch (event.kind) {
        case "ignored":
          return reply.code(200).send({ ok: true, ignored: true });

        case "paid": {
          const externalRef = `${provider.name}:${event.externalRef}`;
          // The metadata id identifies the SUBSCRIPTION, not necessarily the
          // invoice being paid — see resolveInvoiceForPayment for why month two
          // would otherwise be dismissed as a duplicate of month one.
          const resolved = await resolveInvoiceForPayment({
            hintInvoiceId: event.invoiceId,
            externalRef,
          });
          if (!resolved) return reply.code(404).send({ error: "unknown_invoice" });
          if (resolved.alreadyApplied) {
            return reply.code(200).send({ ok: true, alreadyApplied: true });
          }

          const [invoice] = await db
            .select()
            .from(subscriptionInvoices)
            .where(eq(subscriptionInvoices.id, resolved.invoiceId))
            .limit(1);
          if (!invoice) return reply.code(404).send({ error: "unknown_invoice" });

          // Amount comes from the provider's event, but a mismatch against what
          // we opened the invoice for means something is wrong enough to refuse
          // rather than reconcile — a price drift between our plan table and
          // the provider's price object surfaces exactly here.
          if (
            event.amountMinor !== invoice.amountMinor ||
            event.currency !== invoice.currencyCode
          ) {
            req.log.error(
              { invoiceId: invoice.id, expected: invoice.amountMinor, got: event.amountMinor },
              "subscription amount mismatch",
            );
            return reply.code(409).send({ error: "amount_mismatch" });
          }

          const result = await markInvoicePaid({
            invoiceId: invoice.id,
            externalRef,
            providerPayload: event.raw,
          });
          return reply.code(200).send({ ok: true, ...result });
        }

        case "failed": {
          const outcome = await markInvoiceFailed({
            invoiceId: event.invoiceId,
            reason: event.reason,
          });
          return reply.code(200).send({ ok: true, ...outcome });
        }

        case "canceled": {
          const [sub] = await db
            .select()
            .from(subscriptions)
            .where(
              and(
                eq(subscriptions.id, event.subscriptionId),
                eq(subscriptions.provider, provider.name),
              ),
            )
            .limit(1);
          if (!sub) return reply.code(404).send({ error: "unknown_subscription" });

          // The provider has already stopped collecting, so there is nothing
          // left to serve out — this one is immediate, unlike a customer-
          // initiated cancel.
          await cancelSubscription({ subscriptionId: sub.id, immediate: true });
          return reply.code(200).send({ ok: true });
        }
      }
    },
  );
}

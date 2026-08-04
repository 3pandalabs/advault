"use client";

import { useEffect, useState } from "react";
import {
  ApiError,
  cancelSubscription,
  getSubscription,
  listPlans,
  subscribe,
  type Plan,
  type SubscriptionView,
} from "@/lib/api/browser";
import { Badge, Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/utils";

// The subscription. This page is what makes someone a paying customer, and
// before it existed there was no such thing in the product: every plan carried
// a monthly fee of zero and nothing ever charged anyone.
//
// Two lines are sold here and the difference is worth understanding before
// editing the copy. The OFFER plan produces fresh videos every month and never
// touches Google Ads — no developer token, no ad account, no billing setup —
// which is why it is the one someone can buy today. The MANAGED plan is the
// full product and depends on Google approvals that may not be in place.

function fmt(minor: number, currency: string) {
  return new Intl.NumberFormat(currency === "INR" ? "en-IN" : "en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: minor % 100 === 0 ? 0 : 2,
  }).format(minor / 100);
}

const STATUS_COPY: Record<string, string> = {
  pending: "Waiting for your first payment",
  active: "Active",
  past_due: "Payment failed — we're retrying",
  canceled: "Cancelled",
  expired: "Ended",
};

export default function SubscriptionPage() {
  const [view, setView] = useState<SubscriptionView | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = () =>
    getSubscription()
      .then(setView)
      .catch(() => setError("Could not load your subscription."));

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    const currency = view?.subscription?.currencyCode ?? "USD";
    listPlans(currency)
      .then((r) => setPlans(r.plans))
      .catch(() => setPlans([]));
  }, [view?.subscription?.currencyCode]);

  async function onSubscribe(planKey: string) {
    setBusy(true);
    setError(null);
    try {
      const result = await subscribe(planKey);
      if (result.redirectUrl) {
        // Hosted checkout — Paddle, Stripe or a Razorpay mandate page.
        window.location.assign(result.redirectUrl);
        return;
      }
      // No provider is configured, so the manual fallback opened an invoice an
      // operator has to settle. Saying so is better than a spinner that never
      // resolves.
      setNotice(
        "We've set your subscription up. Payment isn't switched on yet — we'll be in touch to complete it.",
      );
      await refresh();
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 409
          ? "You already have a subscription."
          : "Could not start the subscription. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function onCancel() {
    setBusy(true);
    try {
      const result = await cancelSubscription(false);
      setNotice(
        result.servesUntil
          ? `Cancelled. Your ads and videos continue until ${formatDate(result.servesUntil)}.`
          : "Cancelled.",
      );
      await refresh();
    } catch {
      setError("Could not cancel just now.");
    } finally {
      setBusy(false);
    }
  }

  const sub = view?.subscription ?? null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Subscription</h1>
        <p className="mt-1 text-sm text-zinc-400">
          One monthly price. Fresh creative for whatever you&apos;re promoting this month.
        </p>
      </div>

      {error ? <p className="text-sm text-red-400">{error}</p> : null}
      {notice ? <p className="text-sm text-amber-300">{notice}</p> : null}

      {sub ? (
        <Card>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <CardTitle>{sub.display} / month</CardTitle>
              <CardDescription>
                {STATUS_COPY[sub.status] ?? sub.status}
                {sub.currentPeriodEnd ? ` · renews ${formatDate(sub.currentPeriodEnd)}` : ""}
              </CardDescription>
            </div>
            <Badge>{sub.line === "offer" ? "Monthly offer" : "Managed ads"}</Badge>
          </div>

          {/* past_due keeps serving on purpose — that is what the grace window
              is for. The message says what is happening rather than locking the
              customer out of something they have been paying for. */}
          {sub.pastDue ? (
            <p className="mt-4 rounded-lg border border-amber-400/30 bg-amber-400/10 p-3 text-sm text-amber-200">
              We couldn&apos;t take this month&apos;s payment. Your ads are still running while we
              retry — update your payment method to avoid interruption.
            </p>
          ) : null}

          {sub.cancelAtPeriodEnd ? (
            <p className="mt-4 text-sm text-zinc-400">
              Cancelling at the end of this period. Nothing more will be charged.
            </p>
          ) : (
            <Button className="mt-4" variant="ghost" onClick={onCancel} disabled={busy}>
              Cancel subscription
            </Button>
          )}

          {view?.invoices?.length ? (
            <div className="mt-6">
              <p className="text-xs tracking-wide text-zinc-500 uppercase">Billing history</p>
              <ul className="mt-2 divide-y divide-white/5 text-sm">
                {view.invoices.map((inv) => (
                  <li key={inv.id} className="flex items-center justify-between py-2">
                    <span className="text-zinc-400">{formatDate(inv.periodStart)}</span>
                    <span>{fmt(inv.amountMinor, inv.currencyCode)}</span>
                    <span className="text-zinc-500">{inv.status}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {plans.map((plan) => (
            <Card key={plan.key}>
              <CardTitle>{plan.label}</CardTitle>
              <CardDescription>{plan.blurb}</CardDescription>
              <p className="mt-4 text-3xl font-semibold">
                {plan.display.monthlyFee}
                <span className="text-base font-normal text-zinc-400"> / month</span>
              </p>
              <p className="mt-1 text-sm text-zinc-400">
                {plan.includedCreativesPerMonth} fresh videos a month
                {plan.line === "managed" ? ` · ${plan.display.allIn} all-in with ad spend` : ""}
              </p>
              <Button className="mt-4" onClick={() => onSubscribe(plan.key)} disabled={busy}>
                Choose this
              </Button>
            </Card>
          ))}
          {plans.length === 0 ? (
            <p className="text-sm text-zinc-500">Loading plans…</p>
          ) : null}
        </div>
      )}
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  cinematicQuote,
  listCampaigns,
  listCinematicOrders,
  orderCinematic,
  type Campaign,
  type CinematicOrder,
  type CinematicQuote,
} from "@/lib/api/browser";
import { Badge, Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/utils";

// The cinematic add-on: a one-off purchase, not part of any subscription.
//
// The description box is the whole product. What the advertiser types here is
// translated into cinematography — "20% off cakes this August, we're a family
// bakery" becomes lens, light and camera movement — and the model cannot invent
// what they never said. So the placeholder and the helper text are doing real
// work, not decoration: a one-line description produces a one-note ad.

const STATUS_COPY: Record<CinematicOrder["status"], string> = {
  pending: "Waiting for payment",
  paid: "Paid — queued to be made",
  producing: "Being made now",
  delivered: "Ready",
  failed: "Couldn't be made",
  refunded: "Refunded",
  cancelled: "Cancelled",
};

export default function CinematicPage() {
  const [quote, setQuote] = useState<CinematicQuote | null>(null);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [orders, setOrders] = useState<CinematicOrder[]>([]);
  const [campaignId, setCampaignId] = useState("");
  const [description, setDescription] = useState("");
  const [aspectRatio, setAspectRatio] = useState<"16:9" | "9:16">("9:16");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = () =>
    Promise.all([cinematicQuote(), listCampaigns(), listCinematicOrders()])
      .then(([q, c, o]) => {
        setQuote(q);
        setCampaigns(c);
        setOrders(o);
        if (!campaignId && c.length > 0) setCampaignId(c[0].id);
      })
      .catch(() => setError("Could not load this page just now."));

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Anything mid-flight is worth re-checking without a manual refresh —
  // production takes minutes, and a shop owner should not have to reload to
  // find out whether the thing they paid for exists yet.
  useEffect(() => {
    const pending = orders.some((o) => o.status === "paid" || o.status === "producing");
    if (!pending) return;
    const t = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orders]);

  async function onOrder() {
    setBusy(true);
    setError(null);
    try {
      const result = await orderCinematic({ campaignId, description, aspectRatio });
      if (result.checkout.redirectUrl) {
        window.location.assign(result.checkout.redirectUrl);
        return;
      }
      await refresh();
    } catch {
      setError("Could not start the order.");
    } finally {
      setBusy(false);
    }
  }

  const unavailable = quote !== null && !quote.available;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Cinematic ad</h1>
        <p className="mt-1 text-sm text-zinc-400">
          A filmed-looking ad built from a description, closing on your own photo. Bought once,
          not part of your monthly plan.
        </p>
      </div>

      {error ? <p className="text-sm text-red-400">{error}</p> : null}

      {/*
        Said plainly rather than by disabling a button with no explanation. There
        is deliberately no cheaper version of this to fall back to, so "not
        available" is the honest state — not a reason to sell something else.
      */}
      {unavailable ? (
        <Card>
          <CardTitle>Not available right now</CardTitle>
          <CardDescription>
            We can&apos;t make cinematic ads at the moment. Nothing has been charged, and your
            monthly videos are unaffected.
          </CardDescription>
        </Card>
      ) : null}

      {quote && quote.available ? (
        <Card>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <CardTitle>{quote.display.amount}</CardTitle>
              <CardDescription>
                {quote.totalSeconds} seconds — {quote.generatedSeconds} filmed by us, then your own
                photo.
              </CardDescription>
            </div>
            {quote.isFirstPurchase ? <Badge>First one — {quote.display.amount}</Badge> : null}
          </div>
          {quote.isFirstPurchase ? (
            <p className="mt-3 text-sm text-zinc-400">
              Your first one is {quote.display.amount} instead of {quote.display.listPrice}, so you
              can see whether you like it before paying full price.
            </p>
          ) : null}
        </Card>
      ) : null}

      {quote && quote.available ? (
        <Card>
          <CardTitle>What should it show?</CardTitle>
          <CardDescription>
            Tell us in your own words — what you sell, what the place feels like, what&apos;s on
            this month. The more you say, the less generic it looks.
          </CardDescription>

          <label className="mt-4 block text-sm text-zinc-400">
            Campaign
            <select
              className="mt-1 block w-full rounded-lg border border-white/10 bg-black/20 p-2 text-sm"
              value={campaignId}
              onChange={(e) => setCampaignId(e.target.value)}
            >
              {campaigns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>

          <textarea
            className="mt-4 w-full rounded-lg border border-white/10 bg-black/20 p-3 text-sm"
            rows={5}
            minLength={20}
            maxLength={2000}
            placeholder="We're a family bakery, been on this street eleven years. Everything's baked from four in the morning. This August it's 20% off all cakes."
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <p className="mt-1 text-xs text-zinc-500">{description.trim().length} / 2000</p>

          <label className="mt-4 block text-sm text-zinc-400">
            Shape
            <select
              className="mt-1 block rounded-lg border border-white/10 bg-black/20 p-2 text-sm"
              value={aspectRatio}
              onChange={(e) => setAspectRatio(e.target.value as "16:9" | "9:16")}
            >
              <option value="9:16">Tall — Shorts, Reels, WhatsApp</option>
              <option value="16:9">Wide — YouTube, website</option>
            </select>
          </label>

          {/*
            Said up front, before payment. The price, the offer and the business
            name are burnt on as text we control; the filmed part is atmosphere.
            An advertiser who expects the model to render their price will
            otherwise read the result as a mistake.
          */}
          <p className="mt-4 rounded-lg border border-white/10 bg-white/[0.02] p-3 text-xs text-zinc-400">
            The filmed part sets the mood — light, texture, movement. Your offer, your price and
            your name are added as text afterwards, so they always read exactly right. The last
            few seconds are your own photo.
          </p>

          <Button
            className="mt-4"
            onClick={onOrder}
            disabled={busy || !campaignId || description.trim().length < 20}
          >
            {busy ? "Starting…" : `Make it — ${quote.display.amount}`}
          </Button>
          {campaigns.length === 0 ? (
            <p className="mt-2 text-sm text-zinc-400">
              You&apos;ll need a <Link href="/dashboard/campaigns">campaign</Link> first.
            </p>
          ) : null}
        </Card>
      ) : null}

      {orders.length > 0 ? (
        <Card>
          <CardTitle>Your cinematic ads</CardTitle>
          <ul className="mt-4 space-y-3">
            {orders.map((order) => (
              <li
                key={order.id}
                className="flex flex-wrap items-start justify-between gap-3 border-b border-white/5 pb-3 last:border-0"
              >
                <div>
                  <p className="text-sm">{STATUS_COPY[order.status]}</p>
                  <p className="text-xs text-zinc-500">
                    {order.display.amount} · {formatDate(order.createdAt)}
                  </p>
                  {/*
                    Shown, not hidden. Someone who paid and has no ad is owed an
                    explanation and a refund, and burying the reason behind a
                    support email is how that turns into a chargeback.
                  */}
                  {order.status === "failed" ? (
                    <p className="mt-1 text-xs text-red-400">
                      We couldn&apos;t make this one and you should not be out of pocket — we&apos;ll
                      refund it. {order.lastError ? `(${order.lastError})` : null}
                    </p>
                  ) : null}
                </div>
                {order.status === "delivered" && order.campaignId ? (
                  <Link
                    className="text-sm underline"
                    href={`/dashboard/campaigns/${order.campaignId}`}
                  >
                    View
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}

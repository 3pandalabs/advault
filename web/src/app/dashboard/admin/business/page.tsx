"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  ApiError,
  getAdminBusiness,
  getMe,
  type AdminBusiness,
  type BusinessSegment,
} from "@/lib/api/browser";
import { Badge, Card, CardDescription, CardTitle } from "@/components/ui/card";

// Admin-only: customers, the signup -> launch funnel, customer groups,
// categories, revenue and top ads, from GET /admin/business (which enforces
// admin itself; this page only hides the UI from others). Admin accounts are
// not counted as customers.

const n = (v: number) => new Intl.NumberFormat("en-US").format(v);
const pct = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(1)}%`);
const date = (s: string | null) =>
  s ? new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit" }) : "—";

const SEGMENT_TONE: Record<BusinessSegment, "success" | "pending" | "danger" | "neutral"> = {
  regular: "success",
  live: "success",
  paused: "pending",
  lapsed: "danger",
  trying: "pending",
  new: "neutral",
  stalled: "danger",
  never_started: "neutral",
};

export default function AdminBusinessPage() {
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [data, setData] = useState<AdminBusiness | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [segment, setSegment] = useState<BusinessSegment | "all">("all");

  useEffect(() => {
    getMe()
      .then((me) => setAllowed(me.role === "admin"))
      .catch(() => setAllowed(false));
  }, []);

  useEffect(() => {
    if (!allowed) return;
    getAdminBusiness()
      .then(setData)
      .catch((err) => setError(err instanceof ApiError ? err.code : "request_failed"));
  }, [allowed]);

  const labels = useMemo(
    () => Object.fromEntries((data?.segments ?? []).map((s) => [s.key, s.label])) as Record<BusinessSegment, string>,
    [data],
  );
  const shown = (data?.customers ?? []).filter((c) => segment === "all" || c.segment === segment);

  if (allowed === null) return <p className="text-sm text-zinc-500">Loading…</p>;
  if (!allowed) return <p className="text-sm text-zinc-400">This page is for AdVault admins.</p>;

  const top = data?.funnel[0]?.count ?? 0;

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Business</h1>
        <p className="mt-1 text-sm text-zinc-400">
          Customers, groups and categories. Admin accounts are not counted.{" "}
          <Link href="/dashboard/admin" className="text-amber-300 hover:underline">
            Ad performance →
          </Link>{" "}
          <Link href="/dashboard/admin/reviews" className="text-amber-300 hover:underline">
            Video reviews →
          </Link>
        </p>
      </div>

      {error && (
        <p className="mb-4 rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2 text-sm text-red-200">
          Could not load ({error}).
        </p>
      )}
      {!data && !error && <p className="text-sm text-zinc-500">Loading…</p>}

      {data && (
        <div className="space-y-6">
          <Card>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-6">
              <Stat label="Customers" value={n(data.totals.customers)} />
              <Stat label="New · 7 days" value={n(data.totals.signups7d)} />
              <Stat label="New · 30 days" value={n(data.totals.signups30d)} />
              <Stat label="Live now" value={n(data.totals.liveNow)} />
              <Stat label="Ads made" value={n(data.totals.adsMade)} />
              <Stat label="Views" value={n(data.totals.totalViews)} />
            </div>
          </Card>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardTitle>Funnel</CardTitle>
              <CardDescription>How far customers get, from signup to a live ad.</CardDescription>
              <div className="mt-4 space-y-2.5">
                {data.funnel.map((f) => (
                  <div key={f.step}>
                    <div className="flex justify-between text-sm">
                      <span className="text-zinc-300">{f.step}</span>
                      <span className="text-zinc-400">
                        {n(f.count)}
                        {top > 0 ? <span className="ml-2 text-xs text-zinc-500">{pct(f.count / top)}</span> : null}
                      </span>
                    </div>
                    <div className="mt-1 h-2 rounded-full bg-white/5">
                      <div
                        className="h-2 rounded-full bg-amber-400"
                        style={{ width: `${top > 0 ? Math.max(2, (f.count / top) * 100) : 0}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </Card>

            <Card>
              <CardTitle>Customer groups</CardTitle>
              <CardDescription>Each customer is in one group. Tap a group to list them below.</CardDescription>
              <div className="mt-4 divide-y divide-white/5">
                {data.segments.map((s) => (
                  <button
                    key={s.key}
                    type="button"
                    onClick={() => setSegment(segment === s.key ? "all" : s.key)}
                    className={`flex w-full items-center justify-between gap-3 py-2 text-left ${
                      segment === s.key ? "text-amber-200" : ""
                    }`}
                  >
                    <span>
                      <Badge tone={SEGMENT_TONE[s.key]}>{s.label}</Badge>
                      <span className="ml-2 text-xs text-zinc-500">{s.hint}</span>
                    </span>
                    <span className="text-sm font-semibold">{n(s.count)}</span>
                  </button>
                ))}
              </div>
            </Card>
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardTitle>Revenue</CardTitle>
              {data.revenue.length === 0 ? (
                <CardDescription>No paid orders from customers yet.</CardDescription>
              ) : (
                <Table
                  head={["Source", "Orders", "30 days", "All time"]}
                  rows={data.revenue.map((r) => [r.source, n(r.count), r.last30Display, r.allTimeDisplay])}
                  right={[1, 2, 3]}
                />
              )}
            </Card>

            <Card>
              <CardTitle>Categories</CardTitle>
              {data.categories.length === 0 ? (
                <CardDescription>No campaigns yet.</CardDescription>
              ) : (
                <Table
                  head={["Category", "Customers", "Ads", "Launched", "Views"]}
                  rows={data.categories.map((c) => [c.category, n(c.customers), n(c.ads_made), n(c.launched), n(c.views)])}
                  right={[1, 2, 3, 4]}
                />
              )}
            </Card>
          </div>

          <Card>
            <CardTitle>Top ads by views</CardTitle>
            {data.topAds.length === 0 ? (
              <CardDescription>Appears once launched ads get views. Numbers refresh hourly.</CardDescription>
            ) : (
              <Table
                head={["Business", "Category", "Views", "View rate", "Clicks", "Cost / view"]}
                rows={data.topAds.map((a) => [
                  <a key="b" href={`/dashboard/campaigns/${a.campaignId}`} className="font-medium hover:underline">
                    {a.businessName}
                  </a>,
                  a.category,
                  n(a.views),
                  pct(a.viewRate),
                  n(a.clicks),
                  a.costPerView === null ? "—" : `$${a.costPerView.toFixed(3)}`,
                ])}
                right={[2, 3, 4, 5]}
              />
            )}
          </Card>

          <Card>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle>
                Customers{segment !== "all" ? ` · ${labels[segment]}` : ""} ({n(shown.length)})
              </CardTitle>
              {segment !== "all" && (
                <button type="button" onClick={() => setSegment("all")} className="text-xs text-amber-300 hover:underline">
                  Show all
                </button>
              )}
            </div>
            {shown.length === 0 ? (
              <CardDescription>Nobody here yet.</CardDescription>
            ) : (
              <Table
                head={["Customer", "Group", "Signed up", "Photos", "Ads", "Launched", "Views", "Paid", "Last active"]}
                rows={shown.map((c) => [
                  <div key="c">
                    <div className="font-medium text-zinc-200">{c.businessName ?? "—"}</div>
                    <div className="text-xs text-zinc-500">
                      {c.email}
                      {c.category ? ` · ${c.category}` : ""}
                    </div>
                  </div>,
                  <Badge key="s" tone={SEGMENT_TONE[c.segment]}>
                    {labels[c.segment]}
                  </Badge>,
                  date(c.createdAt),
                  n(c.photos),
                  n(c.adsMade),
                  n(c.launched),
                  n(c.views),
                  c.revenueDisplay,
                  date(c.lastActivityAt),
                ])}
                right={[3, 4, 5, 6, 7]}
              />
            )}
          </Card>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs tracking-wide text-zinc-500 uppercase">{label}</p>
      <p className="mt-1 text-xl font-semibold">{value}</p>
    </div>
  );
}

function Table({ head, rows, right = [] }: { head: string[]; rows: React.ReactNode[][]; right?: number[] }) {
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-xs tracking-wide text-zinc-500 uppercase">
          <tr>
            {head.map((h, i) => (
              <th key={h} className={`px-2 py-2 whitespace-nowrap ${right.includes(i) ? "text-right" : ""}`}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-white/5">
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((cell, j) => (
                <td key={j} className={`px-2 py-2 ${right.includes(j) ? "text-right" : ""}`}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

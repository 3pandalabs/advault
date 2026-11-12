"use client";

import { useEffect, useState } from "react";
import { ApiError, getAdminMetrics, getMe, type AdminMetrics } from "@/lib/api/browser";
import { Badge, Card, CardDescription, CardTitle } from "@/components/ui/card";

// Admin-only: performance of every launched campaign, from GET /admin/metrics
// (which enforces admin itself; this page only hides the UI from others).

const RANGES = [7, 30, 90];

const n = (v: number) => new Intl.NumberFormat("en-US").format(v);
const pct = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(1)}%`);

export default function AdminMetricsPage() {
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [days, setDays] = useState(7);
  const [data, setData] = useState<AdminMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getMe()
      .then((me) => setAllowed(me.role === "admin"))
      .catch(() => setAllowed(false));
  }, []);

  useEffect(() => {
    if (!allowed) return;
    getAdminMetrics(days)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((err) => setError(err instanceof ApiError ? err.code : "request_failed"));
  }, [allowed, days]);

  if (allowed === null) return <p className="text-sm text-zinc-500">Loading…</p>;
  if (!allowed) return <p className="text-sm text-zinc-400">This page is for AdVault admins.</p>;

  const totals = data ? Object.entries(data.totals) : [];

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Ad performance</h1>
          <p className="mt-1 text-sm text-zinc-400">Every launched campaign, all customers.</p>
        </div>
        <div className="flex rounded-lg border border-white/15 p-0.5 text-sm">
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setDays(r)}
              className={
                days === r
                  ? "rounded-md bg-amber-400 px-3 py-1 font-medium text-zinc-950"
                  : "rounded-md px-3 py-1 text-zinc-400 hover:text-zinc-200"
              }
            >
              {r} days
            </button>
          ))}
        </div>
      </div>

      {error && (
        <p className="mb-4 rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2 text-sm text-red-200">
          Could not load metrics ({error}).
        </p>
      )}
      {!data && !error && <p className="text-sm text-zinc-500">Loading…</p>}

      {data && (
        <>
          <Card className="mb-6">
            {totals.length === 0 ? (
              <CardDescription>Totals · last {data.days} days · nothing has run yet</CardDescription>
            ) : (
              totals.map(([cur, t]) => (
                <div key={cur}>
                  <CardDescription>
                    Totals · last {data.days} days · {cur}
                  </CardDescription>
                  <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-5">
                    <Stat label="Views" value={n(t.views)} />
                    <Stat label="Impressions" value={n(t.impressions)} />
                    <Stat label="Clicks" value={n(t.clicks)} />
                    <Stat label="Spend" value={t.spendDisplay} />
                    <Stat label="Cost / view" value={t.costPerViewDisplay ?? "—"} />
                  </div>
                </div>
              ))
            )}
          </Card>

          {data.campaigns.length === 0 ? (
            <Card>
              <CardTitle>No launched campaigns yet</CardTitle>
              <CardDescription>
                Campaigns appear here once they are live at Google. Numbers refresh every hour.
              </CardDescription>
            </Card>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-white/10">
              <table className="w-full text-left text-sm">
                <thead className="bg-white/[0.03] text-xs tracking-wide text-zinc-500 uppercase">
                  <tr>
                    <th className="px-3 py-2">Business</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2 text-right">Views</th>
                    <th className="px-3 py-2 text-right">Impr.</th>
                    <th className="px-3 py-2 text-right">Clicks</th>
                    <th className="px-3 py-2 text-right">CTR</th>
                    <th className="px-3 py-2 text-right">Spend</th>
                    <th className="px-3 py-2 text-right">Cost/view</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {data.campaigns.map((c) => (
                    <tr key={c.campaignId}>
                      <td className="px-3 py-2">
                        <a
                          href={`/dashboard/campaigns/${c.campaignId}`}
                          className="font-medium text-zinc-200 hover:underline"
                        >
                          {c.businessName}
                        </a>
                        <div className="text-xs text-zinc-500">
                          {c.userEmail}
                          {c.googleCustomerId ? ` · ${c.googleCustomerId}` : ""}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <Badge tone={c.status === "live" ? "success" : "pending"}>{c.status}</Badge>
                      </td>
                      <td className="px-3 py-2 text-right">{n(c.totals.views)}</td>
                      <td className="px-3 py-2 text-right">{n(c.totals.impressions)}</td>
                      <td className="px-3 py-2 text-right">{n(c.totals.clicks)}</td>
                      <td className="px-3 py-2 text-right">{pct(c.totals.ctr)}</td>
                      <td className="px-3 py-2 text-right">{c.totals.spendDisplay}</td>
                      <td className="px-3 py-2 text-right">{c.totals.costPerViewDisplay ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-4 text-xs text-zinc-500">{data.note}</p>
        </>
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

"use client";

import { useEffect, useState } from "react";
import { getCampaignMetrics, type CampaignMetrics } from "@/lib/api/browser";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";

// Last-7-days performance for a launched campaign. Reads the API's stored copy
// of Google's report (the renderer refreshes it hourly), so opening this page
// never costs a Google API call.

const count = new Intl.NumberFormat("en-US");

function percent(rate: number | null): string {
  return rate === null ? "—" : `${(rate * 100).toFixed(rate < 0.1 ? 2 : 1)}%`;
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-white/10 px-3 py-2">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
      {hint && <div className="text-xs text-zinc-500">{hint}</div>}
    </div>
  );
}

export function PerformanceCard({ campaignId }: { campaignId: string }) {
  const [data, setData] = useState<CampaignMetrics | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    getCampaignMetrics(campaignId, 7)
      .then(setData)
      .catch(() => setFailed(true));
  }, [campaignId]);

  return (
    <Card className="mt-6">
      <CardTitle>Performance · last 7 days</CardTitle>
      {failed ? (
        <CardDescription>Could not load performance right now.</CardDescription>
      ) : !data ? (
        <CardDescription>Loading…</CardDescription>
      ) : !data.totals || data.daily.length === 0 ? (
        <CardDescription>
          No activity reported yet. Google reviews new ads first, and its numbers arrive a few
          hours behind — check back later today.
        </CardDescription>
      ) : (
        <>
          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
            <Stat label="Impressions" value={count.format(data.totals.impressions)} />
            <Stat
              label="Views"
              value={count.format(data.totals.views)}
              hint={`${percent(data.totals.viewRate)} view rate`}
            />
            <Stat
              label="Clicks"
              value={count.format(data.totals.clicks)}
              hint={`${percent(data.totals.ctr)} CTR`}
            />
            <Stat label="Spend" value={data.totals.spendDisplay} />
            <Stat label="Cost per view" value={data.totals.costPerViewDisplay ?? "—"} />
          </div>

          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm tabular-nums">
              <thead className="text-left text-xs text-zinc-500">
                <tr>
                  <th className="py-1 pr-3 font-normal">Date</th>
                  <th className="py-1 pr-3 text-right font-normal">Impressions</th>
                  <th className="py-1 pr-3 text-right font-normal">Views</th>
                  <th className="py-1 pr-3 text-right font-normal">Clicks</th>
                  <th className="py-1 text-right font-normal">Spend</th>
                </tr>
              </thead>
              <tbody>
                {data.daily.map((d) => (
                  <tr key={d.date} className="border-t border-white/5">
                    <td className="py-1 pr-3 text-zinc-400">{d.date}</td>
                    <td className="py-1 pr-3 text-right">{count.format(d.impressions)}</td>
                    <td className="py-1 pr-3 text-right">{count.format(d.views)}</td>
                    <td className="py-1 pr-3 text-right">{count.format(d.clicks)}</td>
                    <td className="py-1 text-right">{d.spendDisplay}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <p className="mt-3 text-xs text-zinc-500">
        {data?.note ?? "Google Ads reports lag by a few hours."}
        {data?.lastSyncedAt && ` Last updated ${new Date(data.lastSyncedAt).toLocaleString()}.`}
      </p>
    </Card>
  );
}

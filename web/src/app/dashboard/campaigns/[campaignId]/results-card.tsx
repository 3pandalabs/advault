"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  ApiError,
  getCampaignResults,
  updateTargeting,
  type Campaign,
  type CampaignResults,
  type ResultsSuggestion,
  type ResultsBreakdown,
  type ResultsRange,
} from "@/lib/api/browser";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { formatMoney } from "@/lib/utils";

// "How your ad is doing" (2026-11-19). Replaces the 7-day Performance card.
// Reads GET /campaigns/:id/results: the API's stored copy of Google's reports
// (renderer sweep, hourly; breakdowns every 3 hours), never Google itself.
// Cost per view is the hero number, cost per click right beside it, each with
// a plain-English "What's this?" and the sum in words.

const RANGES: { value: ResultsRange; label: string }[] = [
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "all", label: "All time" },
];

const count = new Intl.NumberFormat("en-US");

/** "4¢", "1.3¢", "$1.25". Input in cents (may be fractional). */
function perUnit(cents: number, currency: string): string {
  if (currency !== "USD" || cents >= 100) return formatMoney(Math.round(cents), currency);
  if (cents < 0.1) return "less than 1¢";
  return `${cents < 10 ? Number(cents.toFixed(1)) : Math.round(cents)}¢`;
}

function Explainer({ text, sum }: { text: string; sum: string | null }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-1">
      <button
        type="button"
        className="text-xs text-zinc-400 underline underline-offset-4 hover:text-zinc-200"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        What&apos;s this?
      </button>
      {open && (
        <p className="mt-1 text-xs text-zinc-300">
          {text}
          {sum && <span className="mt-1 block text-zinc-400">{sum}</span>}
        </p>
      )}
    </div>
  );
}

function Hero({
  label,
  value,
  sub,
  empty,
  text,
  sum,
}: {
  label: string;
  value: string | null;
  sub: string;
  empty: string;
  text: string;
  sum: string | null;
}) {
  return (
    <div className="rounded-xl border border-amber-400/20 bg-amber-400/[0.04] p-4">
      <div className="text-sm text-zinc-300">{label}</div>
      <div className="mt-1 text-3xl font-semibold tabular-nums text-amber-300">{value ?? "—"}</div>
      <div className="text-xs text-zinc-400">{value ? sub : empty}</div>
      <Explainer text={text} sum={value ? sum : null} />
    </div>
  );
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

/** A small line over days. No axes: the numbers sit in the stats above. */
function Sparkline({ values, label, format }: { values: (number | null)[]; label: string; format: (n: number) => string }) {
  const pts = values.map((v, i) => ({ i, v })).filter((p): p is { i: number; v: number } => p.v !== null);
  if (pts.length < 2) return null;
  const w = 280;
  const h = 56;
  const max = Math.max(...pts.map((p) => p.v));
  const min = Math.min(...pts.map((p) => p.v));
  const span = max - min || 1;
  const x = (i: number) => (values.length === 1 ? w / 2 : (i / (values.length - 1)) * (w - 8) + 4);
  const y = (v: number) => h - 6 - ((v - min) / span) * (h - 12);
  const d = pts.map((p, k) => `${k === 0 ? "M" : "L"}${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1]!;
  return (
    <figure className="rounded-lg border border-white/10 p-3">
      <figcaption className="flex justify-between text-xs text-zinc-400">
        <span>{label}</span>
        <span className="tabular-nums text-zinc-200">Latest {format(last.v)}</span>
      </figcaption>
      <svg viewBox={`0 0 ${w} ${h}`} className="mt-2 h-14 w-full" role="img" aria-label={label} preserveAspectRatio="none">
        <path d={d} fill="none" stroke="currentColor" strokeWidth={2} className="text-amber-300" vectorEffect="non-scaling-stroke" />
        <circle cx={x(last.i)} cy={y(last.v)} r={3} className="fill-amber-300" />
      </svg>
    </figure>
  );
}

function Bars({ title, items, max }: { title: string; items: ResultsBreakdown; max?: number }) {
  return (
    <div>
      <h4 className="text-sm font-medium text-zinc-200">{title}</h4>
      {!items ? (
        <p className="mt-1 text-xs text-zinc-500">Not enough views yet</p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {items.slice(0, max ?? items.length).map((it) => (
            <li key={it.segment} className="text-xs">
              <div className="flex justify-between gap-2 text-zinc-300">
                <span className="truncate">{it.label}</span>
                <span className="tabular-nums text-zinc-400">{Math.round(it.share * 100)}%</span>
              </div>
              <div className="mt-0.5 h-1.5 rounded bg-white/5">
                <div className="h-1.5 rounded bg-amber-300/80" style={{ width: `${Math.max(it.share * 100, 2)}%` }} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Hours as 24 thin columns; busiest = tallest. */
function HourStrip({ items }: { items: ResultsBreakdown }) {
  if (!items) {
    return (
      <div>
        <h4 className="text-sm font-medium text-zinc-200">Time of day</h4>
        <p className="mt-1 text-xs text-zinc-500">Not enough views yet</p>
      </div>
    );
  }
  const byHour = new Map(items.map((i) => [Number(i.segment), i]));
  const top = Math.max(...items.map((i) => i.share));
  const best = items.reduce((a, b) => (b.share > a.share ? b : a));
  return (
    <div>
      <h4 className="text-sm font-medium text-zinc-200">Time of day</h4>
      <div className="mt-2 flex h-16 items-end gap-[2px]" role="img" aria-label={`Busiest around ${best.label}`}>
        {Array.from({ length: 24 }, (_, h) => {
          const it = byHour.get(h);
          return (
            <div
              key={h}
              title={it ? `${it.label}: ${Math.round(it.share * 100)}%` : undefined}
              className="flex-1 rounded-t bg-amber-300/80"
              style={{ height: `${it ? Math.max((it.share / top) * 100, 4) : 2}%`, opacity: it ? 1 : 0.2 }}
            />
          );
        })}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-zinc-500">
        <span>12am</span>
        <span>6am</span>
        <span>12pm</span>
        <span>6pm</span>
        <span>11pm</span>
      </div>
      <p className="mt-1 text-xs text-zinc-400">Busiest around {best.label}.</p>
    </div>
  );
}

/**
 * One smart suggestion: the saving in a sentence, the reach warning, and a
 * button that narrows the campaign at Google (PUT /campaigns/:id/targeting).
 */
function SuggestionCard({
  campaignId,
  s,
  onApplied,
}: {
  campaignId: string;
  s: ResultsSuggestion;
  onApplied?: (c: Campaign) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  async function apply() {
    setBusy(true);
    setResult(null);
    try {
      const res = await updateTargeting(campaignId, s.apply);
      onApplied?.(res.campaign);
      setResult({ ok: true, text: "Done. Google now focuses your ad there. You can widen it again any time." });
    } catch (err) {
      setResult({
        ok: false,
        text:
          err instanceof ApiError && err.detail
            ? `Not changed. ${err.detail}`
            : "Not changed: we couldn't reach Google. Please try again.",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-emerald-400/25 bg-emerald-400/[0.05] p-4">
      <p className="text-sm text-zinc-100">
        {s.message} <span className="font-semibold">{s.question}</span>
      </p>
      <p className="mt-2 text-xs text-amber-200">{s.reachWarning}</p>
      {result ? (
        <p className={`mt-3 text-sm ${result.ok ? "text-emerald-300" : "text-red-300"}`}>{result.text}</p>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={apply}
          className="mt-3 rounded-lg border border-emerald-400/50 px-3 py-1.5 text-sm text-emerald-200 hover:bg-emerald-400/10 disabled:opacity-50"
        >
          {busy ? "Applying…" : s.action}
        </button>
      )}
    </div>
  );
}

/** "12.5%" from a 0..1 rate; null when there is nothing to divide by. */
function pct(part: number, whole: number): string | null {
  if (whole <= 0) return null;
  const p = (part / whole) * 100;
  return `${p >= 10 ? Math.round(p) : Number(p.toFixed(1))}%`;
}

export function ResultsCard({
  campaignId,
  onTargetingChanged,
  embedded = false,
  initialRange = "7d",
}: {
  campaignId: string;
  onTargetingChanged?: (c: Campaign) => void;
  /**
   * Inside another card (the dashboard list's "See details", 2026-11-21): no
   * outer Card and no title, the parent already has both. It fetches on
   * mount, so the parent mounts it only when opened.
   */
  embedded?: boolean;
  initialRange?: ResultsRange;
}) {
  const [range, setRange] = useState<ResultsRange>(initialRange);
  const [data, setData] = useState<CampaignResults | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getCampaignResults(campaignId, range)
      .then((d) => {
        if (!cancelled) {
          setData(d);
          setFailed(false);
        }
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [campaignId, range]);

  const r = data && data.launched && data.range === range ? data : null;
  const t = r?.totals ?? null;
  const cur = r?.currency ?? "USD";
  const spent = t ? formatMoney(t.spendMinor, cur) : "";
  const cpvCents = t && t.views > 0 ? t.costMicros / 10_000 / t.views : null;
  const cpcCents = t && t.clicks > 0 ? t.costMicros / 10_000 / t.clicks : null;

  const viewRate = t ? pct(t.views, t.impressions) : null;
  const clickRate = t ? pct(t.clicks, t.impressions) : null;
  const Shell = embedded ? EmbeddedShell : PageShell;

  return (
    <Shell>
      <div className={`flex flex-wrap items-center gap-2 ${embedded ? "justify-end" : "justify-between"}`}>
        {!embedded && <CardTitle>How your ad is doing</CardTitle>}
        <div className="flex gap-1" role="tablist" aria-label="Date range">
          {RANGES.map((o) => (
            <button
              key={o.value}
              type="button"
              role="tab"
              aria-selected={range === o.value}
              onClick={() => setRange(o.value)}
              className={`rounded-lg border px-2.5 py-1 text-xs ${
                range === o.value
                  ? "border-amber-400 bg-amber-400/10 text-amber-200"
                  : "border-white/10 text-zinc-400 hover:border-white/25"
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>

      {failed ? (
        <CardDescription className="mt-3">Could not load your results right now.</CardDescription>
      ) : !r ? (
        <CardDescription className="mt-3">Loading…</CardDescription>
      ) : !t || t.impressions === 0 ? (
        <CardDescription className="mt-3">
          No results yet. Google reviews new ads first, and its numbers arrive about 3 hours late —
          check back later today.
        </CardDescription>
      ) : (
        <>
          {t.views > 0 && (
            <p className="mt-3 text-lg">
              <span className="font-semibold">{count.format(t.views)} views</span> at{" "}
              <span className="font-semibold text-amber-300">{perUnit(cpvCents!, cur)} each</span>
            </p>
          )}

          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <Hero
              label="Cost per view"
              value={cpvCents === null ? null : perUnit(cpvCents, cur)}
              sub="each time someone watched"
              empty="No views yet"
              text="What you paid, on average, each time someone watched your ad. Lower means your budget reaches more people."
              sum={cpvCents === null ? null : `${spent} spent ÷ ${count.format(t.views)} views = ${perUnit(cpvCents, cur)} per view`}
            />
            <Hero
              label="Cost per click"
              value={cpcCents === null ? null : perUnit(cpcCents, cur)}
              sub="each time someone tapped your ad"
              empty="No clicks yet"
              text="What you paid, on average, each time someone tapped your ad to visit your site, call or get directions. Lower means you're getting customers to act for less."
              sum={cpcCents === null ? null : `${spent} ÷ ${count.format(t.clicks)} clicks = ${perUnit(cpcCents, cur)} per click`}
            />
          </div>
          <p className="mt-2 text-xs text-zinc-400">
            Google charges per click; cost per view shows how far your budget stretches.
          </p>

          {r.suggestions && r.suggestions.length > 0 && (
            <div className="mt-4 space-y-2">
              <h3 className="text-sm font-semibold text-zinc-100">Suggestions</h3>
              {r.suggestions.map((s) => (
                <SuggestionCard key={s.id} campaignId={campaignId} s={s} onApplied={onTargetingChanged} />
              ))}
            </div>
          )}

          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Stat label="Views" value={count.format(t.views)} />
            <Stat label="Clicks" value={count.format(t.clicks)} />
            <Stat label="Times shown" value={count.format(t.impressions)} />
            <Stat label="Spent" value={t.spendDisplay} />
            {r.balance && <Stat label="Budget left" value={r.balance.display} />}
            {viewRate && <Stat label="View rate" value={viewRate} hint="of times shown were watched" />}
            {clickRate && <Stat label="Click rate" value={clickRate} hint="of times shown got a tap" />}
          </div>

          {r.websiteLeads && (
            <div className="mt-4 rounded-lg border border-white/10 p-3">
              <h3 className="text-sm font-semibold text-zinc-100">Leads from your website</h3>
              <p className="mt-0.5 text-xs text-zinc-500">People who came from this ad and then asked you for something.</p>
              <div className="mt-2 grid grid-cols-3 gap-2">
                <Stat label="Quotes" value={count.format(r.websiteLeads.quote)} />
                <Stat label="Call backs" value={count.format(r.websiteLeads.callback)} />
                <Stat label="Bookings" value={count.format(r.websiteLeads.booking)} />
              </div>
              {r.websiteLeads.total > 0 && (
                <Link href="/dashboard/leads" className="mt-2 inline-block text-xs text-amber-300 underline">
                  See your leads
                </Link>
              )}
            </div>
          )}

          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            <Sparkline values={r.trend.map((d) => d.views)} label="Views per day" format={(n) => count.format(n)} />
            <Sparkline
              values={r.trend.map((d) => (d.views > 0 ? d.spendMinor / d.views : null))}
              label="Cost per view per day"
              format={(n) => perUnit(n, cur)}
            />
          </div>

          <h3 className="mt-6 text-sm font-semibold text-zinc-100">Who&apos;s watching</h3>
          <div className="mt-2 grid gap-4 sm:grid-cols-3">
            <Bars title="Age" items={r.breakdowns.age} />
            <Bars title="Gender" items={r.breakdowns.gender} />
            <Bars title="Device" items={r.breakdowns.device} />
          </div>

          <h3 className="mt-6 text-sm font-semibold text-zinc-100">Where</h3>
          <div className="mt-2 grid gap-4 sm:grid-cols-2">
            <Bars title="Top areas" items={r.breakdowns.location} max={5} />
            <Bars title="Where it played" items={r.breakdowns.network} />
          </div>

          <h3 className="mt-6 text-sm font-semibold text-zinc-100">When</h3>
          <div className="mt-2 grid gap-4 sm:grid-cols-2">
            <Bars title="Day of the week" items={r.breakdowns.dayOfWeek} />
            <HourStrip items={r.breakdowns.hour} />
          </div>
        </>
      )}

      <p className="mt-4 text-xs text-zinc-500">
        Google&apos;s numbers arrive about 3 hours late. If your budget goes down fast, Google is
        finding people to show your ad to — keep an eye on cost per view and clicks.
        {r?.lastSyncedAt && ` Last updated ${new Date(r.lastSyncedAt).toLocaleString()}.`}
      </p>
    </Shell>
  );
}

function PageShell({ children }: { children: React.ReactNode }) {
  return <Card className="mt-6">{children}</Card>;
}

function EmbeddedShell({ children }: { children: React.ReactNode }) {
  return <div>{children}</div>;
}

"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ApiError, getMe } from "@/lib/api/browser";
import {
  approveWording,
  dismissReport,
  getComplianceQueue,
  listAdminReports,
  REPORT_REASONS,
  takeDownCampaign,
  type AdminReport,
  type AdminReportStatus,
  type ComplianceCampaign,
  type TakedownResult,
} from "@/lib/api/compliance";
import { Badge, Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";

// Admin-only: public "Report this ad" submissions, wording waiting for review
// (REVIEW rules, campaigns.compliance_status = needs_review) and takedowns.
// The API enforces admin (JWT role AND users.role); this page only hides the
// UI from others. Routes: api/src/routes/reports.ts.

const TABS: { status: AdminReportStatus; label: string }[] = [
  { status: "open", label: "Open" },
  { status: "dismissed", label: "Dismissed" },
  { status: "actioned", label: "Actioned" },
];

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "—");
const reasonLabel = (r: string) => REPORT_REASONS.find((x) => x.value === r)?.label ?? r;
const errCode = (err: unknown) => (err instanceof ApiError ? err.code : "request_failed");

export default function AdminReportsPage() {
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [status, setStatus] = useState<AdminReportStatus>("open");
  const [reports, setReports] = useState<AdminReport[] | null>(null);
  const [queue, setQueue] = useState<{ needsReview: ComplianceCampaign[]; takenDown: ComplianceCampaign[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);
  const reload = useCallback(() => setReloads((n) => n + 1), []);

  useEffect(() => {
    getMe()
      .then((me) => setAllowed(me.role === "admin"))
      .catch(() => setAllowed(false));
  }, []);

  useEffect(() => {
    if (!allowed) return;
    let cancelled = false;
    Promise.all([listAdminReports(status), getComplianceQueue()])
      .then(([r, q]) => {
        if (cancelled) return;
        setReports(r.reports);
        setQueue(q);
        setError(null);
      })
      .catch((err) => !cancelled && setError(errCode(err)));
    return () => {
      cancelled = true;
    };
  }, [allowed, status, reloads]);

  if (allowed === null) return <p className="text-sm text-zinc-500">Loading…</p>;
  if (!allowed) return <p className="text-sm text-zinc-400">This page is for AdVault admins.</p>;

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Reports & wording reviews</h1>
        <p className="mt-1 text-sm text-zinc-400">
          Wording that must be approved before launch, public reports, and takedowns.{" "}
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

      <h2 className="mb-3 text-lg font-semibold">Wording waiting for review</h2>
      {!queue && !error && <p className="text-sm text-zinc-500">Loading…</p>}
      {queue && queue.needsReview.length === 0 && (
        <p className="mb-2 text-sm text-zinc-500">Nothing is waiting for a wording review.</p>
      )}
      <div className="space-y-4">
        {queue?.needsReview.map((c) => <WordingCard key={c.campaignId} campaign={c} onDone={reload} />)}
      </div>

      <div className="mt-10 mb-3 flex flex-wrap items-end justify-between gap-3">
        <h2 className="text-lg font-semibold">Reports</h2>
        <div className="flex rounded-lg border border-white/15 p-0.5 text-sm">
          {TABS.map((t) => (
            <button
              key={t.status}
              type="button"
              onClick={() => {
                if (t.status === status) return;
                setReports(null);
                setStatus(t.status);
              }}
              className={
                status === t.status
                  ? "rounded-md bg-amber-400 px-3 py-1 font-medium text-zinc-950"
                  : "rounded-md px-3 py-1 text-zinc-400 hover:text-zinc-200"
              }
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
      {reports && reports.length === 0 && <p className="text-sm text-zinc-500">No reports here.</p>}
      <div className="space-y-4">
        {reports?.map((r) => <ReportCard key={r.id} report={r} onDone={reload} />)}
      </div>

      {queue && queue.takenDown.length > 0 && (
        <details className="mt-10">
          <summary className="cursor-pointer text-lg font-semibold">Taken down ({queue.takenDown.length})</summary>
          <div className="mt-3 space-y-3">
            {queue.takenDown.map((c) => (
              <Card key={c.campaignId}>
                <CardTitle>
                  <Link href={`/dashboard/campaigns/${c.campaignId}`} className="hover:underline">
                    {c.businessName}
                  </Link>
                </CardTitle>
                <CardDescription>
                  {c.name} · {c.ownerEmail} · taken down {when(c.takenDownAt)}
                </CardDescription>
                {c.takenDownReason && <p className="mt-2 text-sm text-zinc-400">Reason: {c.takenDownReason}</p>}
              </Card>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function WordingCard({ campaign: c, onDone }: { campaign: ComplianceCampaign; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function approve() {
    setBusy(true);
    setError(null);
    try {
      await approveWording(c.campaignId);
      onDone();
    } catch (err) {
      setError(errCode(err));
      setBusy(false);
    }
  }

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <CardTitle>
            <Link href={`/dashboard/campaigns/${c.campaignId}`} className="hover:underline">
              {c.businessName}
            </Link>
          </CardTitle>
          <CardDescription>
            {c.name} · {c.businessCategory ?? "no category"} · {c.ownerEmail} · {c.status}
          </CardDescription>
        </div>
        <Badge tone="pending">Needs review</Badge>
      </div>
      {c.offerDetails && <p className="mt-3 break-words text-sm text-zinc-300">Offer: &ldquo;{c.offerDetails}&rdquo;</p>}
      <ul className="mt-3 space-y-2 text-sm">
        {(c.complianceReasons ?? []).map((r) => (
          <li key={`${r.id}:${r.phrase}:${r.field}`} className="rounded-lg border border-white/10 bg-white/5 px-3 py-2">
            <span className="font-medium text-amber-200">&ldquo;{r.phrase}&rdquo;</span>{" "}
            <span className="text-zinc-500">in {r.field}</span>
            {r.approved && <span className="ml-2 text-emerald-300">(approved before)</span>}
            <p className="mt-1 text-zinc-400">{r.reason}</p>
          </li>
        ))}
      </ul>
      {error && <p className="mt-3 text-sm text-red-300">Failed ({error}).</p>}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button size="sm" onClick={approve} disabled={busy}>
          {busy ? "Approving…" : "Approve wording"}
        </Button>
        <TakedownButton campaignId={c.campaignId} onDone={onDone} />
      </div>
    </Card>
  );
}

function ReportCard({ report: r, onDone }: { report: AdminReport; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function dismiss() {
    setBusy(true);
    setError(null);
    try {
      await dismissReport(r.id);
      onDone();
    } catch (err) {
      setError(errCode(err));
      setBusy(false);
    }
  }

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <CardTitle>
            {r.campaignId ? (
              <Link href={`/dashboard/campaigns/${r.campaignId}`} className="hover:underline">
                {r.businessName}
              </Link>
            ) : (
              "Deleted campaign"
            )}
          </CardTitle>
          <CardDescription>
            {r.campaignName ?? "—"} · {r.ownerEmail ?? "—"} · reported {when(r.createdAt)}
          </CardDescription>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge tone={r.reason === "scam_or_fraud" ? "danger" : "pending"}>{reasonLabel(r.reason)}</Badge>
          {r.complianceStatus && r.complianceStatus !== "ok" && (
            <Badge tone={r.complianceStatus === "taken_down" ? "danger" : "pending"}>
              {r.complianceStatus === "taken_down" ? "Taken down" : "Wording needs review"}
            </Badge>
          )}
        </div>
      </div>
      {r.details && <p className="mt-3 whitespace-pre-wrap break-words text-sm text-zinc-300">{r.details}</p>}
      <p className="mt-2 text-xs text-zinc-500">
        Reporter: {r.reporterEmail ? <a href={`mailto:${r.reporterEmail}`} className="underline">{r.reporterEmail}</a> : "no email"}
        {r.publicId && (
          <>
            {" · "}
            <a href={`/report?ad=${encodeURIComponent(r.publicId)}`} target="_blank" rel="noreferrer" className="underline">
              public report page
            </a>
          </>
        )}
        {r.landingUrl && (
          <>
            {" · "}
            <a href={r.landingUrl} target="_blank" rel="noreferrer" className="underline">
              their website
            </a>
          </>
        )}
        {r.status !== "open" && ` · ${r.status} ${when(r.handledAt)}`}
      </p>
      {error && <p className="mt-3 text-sm text-red-300">Failed ({error}).</p>}
      {r.status === "open" && (
        <div className="mt-4 flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={dismiss} disabled={busy}>
            {busy ? "Dismissing…" : "Dismiss"}
          </Button>
          {r.campaignId && r.complianceStatus !== "taken_down" && (
            <TakedownButton campaignId={r.campaignId} onDone={onDone} />
          )}
        </div>
      )}
    </Card>
  );
}

function TakedownButton({ campaignId, onDone }: { campaignId: string; onDone: () => void }) {
  const [step, setStep] = useState<"idle" | "reason" | "confirm">("idle");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TakedownResult | null>(null);

  async function takeDown() {
    setBusy(true);
    setError(null);
    try {
      setResult(await takeDownCampaign(campaignId, reason.trim()));
    } catch (err) {
      setError(errCode(err));
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    const made = result.videos.filter((v) => v.private).length;
    const manual = result.google === "failed" || result.google === "unreachable" || made < result.videos.length;
    return (
      <div className="w-full rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2 text-sm text-red-100">
        <p>
          Taken down. Google: {result.google.replaceAll("_", " ")}. Videos made private: {made}/{result.videos.length}.
        </p>
        {manual && (
          <p className="mt-1 font-medium">
            Manual steps needed: see the ops alert (pause in Google Ads and/or set the YouTube videos private by hand).
          </p>
        )}
        <p className="mt-1">If it was on an AdVault-made website, remove the video there by hand too.</p>
        <Button size="sm" variant="outline" className="mt-2" onClick={onDone}>
          Done
        </Button>
      </div>
    );
  }

  if (step === "idle") {
    return (
      <Button size="sm" variant="destructive" onClick={() => setStep("reason")}>
        Take down
      </Button>
    );
  }

  return (
    <div className="w-full space-y-2">
      <Textarea
        rows={2}
        maxLength={1000}
        placeholder="Why (kept on the campaign and sent to ops)"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        disabled={busy || step === "confirm"}
      />
      {error && <p className="text-sm text-red-300">Failed ({error}).</p>}
      <div className="flex flex-wrap gap-2">
        {step === "reason" ? (
          <Button size="sm" variant="destructive" disabled={reason.trim().length < 3} onClick={() => setStep("confirm")}>
            Continue
          </Button>
        ) : (
          <Button size="sm" variant="destructive" disabled={busy} onClick={takeDown}>
            {busy ? "Taking down…" : "Yes, pause it and make its videos private"}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            setStep("idle");
            setError(null);
          }}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

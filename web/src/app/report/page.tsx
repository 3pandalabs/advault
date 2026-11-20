"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { ApiError } from "@/lib/api/browser";
import { getPublicAd, REPORT_REASONS, submitReport, type PublicAdStatus, type ReportReason } from "@/lib/api/compliance";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { FieldHint, Input, Label, Textarea } from "@/components/ui/input";
import { WordmarkName, WordmarkTag } from "@/components/Wordmark";

// Public "Report this ad" (api routes/reports.ts). Linked from the YouTube
// description of every ad AdVault publishes: /report?ad=<campaigns.public_id>.
// No account needed. The API rate-limits per IP and pings ops.

export default function ReportPage() {
  return (
    <main className="mx-auto w-full max-w-md px-4 py-12 sm:px-6">
      <div className="mb-8 text-center text-lg font-semibold tracking-tight">
        <Link href="/">
          <WordmarkName />
        </Link>
        <WordmarkTag />
      </div>
      <Suspense fallback={<p className="text-center text-sm text-zinc-500">Loading…</p>}>
        <ReportForm />
      </Suspense>
    </main>
  );
}

function ReportForm() {
  const ad = useSearchParams().get("ad")?.trim() ?? "";
  const [state, setState] = useState<PublicAdStatus | "loading" | "error">(ad ? "loading" : { status: "not_found" });
  const [reason, setReason] = useState<ReportReason | "">("");
  const [details, setDetails] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  useEffect(() => {
    if (!ad) return;
    let cancelled = false;
    getPublicAd(ad)
      .then((s) => !cancelled && setState(s))
      .catch(() => !cancelled && setState("error"));
    return () => {
      cancelled = true;
    };
  }, [ad]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!reason) return;
    setBusy(true);
    setError(null);
    try {
      await submitReport({ ad, reason, details: details.trim() || undefined, email: email.trim() || undefined });
      setSent(true);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "";
      if (code === "too_many_reports") setError("Too many reports from your network. Please try again in an hour.");
      else if (code === "ad_removed") setState({ status: "removed" });
      else if (code === "not_found") setState({ status: "not_found" });
      else setError("Could not send your report. Please try again, or email 3pandas@3pandalabs.com.");
    } finally {
      setBusy(false);
    }
  }

  if (!ad) {
    return (
      <Card>
        <h1 className="text-xl font-semibold">Report an AdVault ad</h1>
        <p className="mt-2 text-sm text-zinc-400">
          Every ad we publish on YouTube has a &ldquo;Report this ad&rdquo; link in its description: open
          that link to report it. You can also email{" "}
          <a href="mailto:3pandas@3pandalabs.com" className="text-amber-300 underline">
            3pandas@3pandalabs.com
          </a>{" "}
          with a link to the video.
        </p>
      </Card>
    );
  }
  if (state === "loading") return <p className="text-center text-sm text-zinc-500">Loading…</p>;
  if (state === "error") {
    return (
      <Card>
        <h1 className="text-xl font-semibold">Something went wrong</h1>
        <p className="mt-2 text-sm text-zinc-400">
          We couldn&rsquo;t load this ad. Please try again, or email{" "}
          <a href="mailto:3pandas@3pandalabs.com" className="text-amber-300 underline">
            3pandas@3pandalabs.com
          </a>
          .
        </p>
      </Card>
    );
  }
  if (state.status === "not_found") {
    return (
      <Card>
        <h1 className="text-xl font-semibold">We couldn&rsquo;t find that ad.</h1>
        <p className="mt-2 text-sm text-zinc-400">
          Check the link from the video description. To report something else, email{" "}
          <a href="mailto:3pandas@3pandalabs.com" className="text-amber-300 underline">
            3pandas@3pandalabs.com
          </a>
          .
        </p>
      </Card>
    );
  }
  if (state.status === "removed") {
    return (
      <Card>
        <h1 className="text-xl font-semibold">This ad has been removed.</h1>
        <p className="mt-2 text-sm text-zinc-400">AdVault has taken this ad down. Thank you to everyone who reported it.</p>
      </Card>
    );
  }
  if (sent) {
    return (
      <Card>
        <h1 className="text-xl font-semibold">Thank you</h1>
        <p className="mt-2 text-sm text-zinc-400">
          A person at AdVault will look at this ad. If it breaks our{" "}
          <Link href="/content-policy" className="text-amber-300 underline">
            Content Policy
          </Link>{" "}
          we will remove it.
        </p>
      </Card>
    );
  }

  return (
    <Card>
      <h1 className="text-xl font-semibold">Report an ad by {state.businessName}</h1>
      <p className="mt-2 text-sm text-zinc-400">
        Tell us what is wrong with this ad. A person reads every report. See our{" "}
        <Link href="/content-policy" className="text-amber-300 underline">
          Content Policy
        </Link>
        .
      </p>
      <form onSubmit={onSubmit} className="mt-6 space-y-4">
        <div>
          <Label htmlFor="reason">What is wrong?</Label>
          <select
            id="reason"
            required
            value={reason}
            onChange={(e) => setReason(e.target.value as ReportReason)}
            className="h-10 w-full rounded-lg border border-white/15 bg-white/5 px-3 text-sm text-zinc-100 focus:border-amber-400/60 focus:outline-none focus:ring-1 focus:ring-amber-400/60"
          >
            <option value="" className="bg-zinc-900">
              Choose a reason
            </option>
            {REPORT_REASONS.map((r) => (
              <option key={r.value} value={r.value} className="bg-zinc-900">
                {r.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label htmlFor="details">Details (optional)</Label>
          <Textarea
            id="details"
            rows={4}
            maxLength={2000}
            value={details}
            onChange={(e) => setDetails(e.target.value)}
            placeholder="What in the ad is wrong, and how do you know?"
          />
        </div>
        <div>
          <Label htmlFor="email">Your email (optional)</Label>
          <Input id="email" type="email" maxLength={320} value={email} onChange={(e) => setEmail(e.target.value)} />
          <FieldHint>Only if you want us to be able to reply. We never share it with the advertiser.</FieldHint>
        </div>
        {error && <p className="text-sm text-red-300">{error}</p>}
        <Button type="submit" className="w-full" disabled={busy || !reason}>
          {busy ? "Sending…" : "Send report"}
        </Button>
      </form>
    </Card>
  );
}

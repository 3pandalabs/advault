"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { applyLeadLink, previewLeadLink, type LeadLinkPreview, type LeadStatus } from "@/lib/api/browser";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

// One-click Confirm / Decline from the owner's booking email (api
// routes/leads.ts /leads/link). Two steps on purpose: opening the link only
// shows the booking (a mail scanner that follows links changes nothing); the
// owner's tap applies it. No sign-in needed: the signed token is the proof.

function Action() {
  const token = useSearchParams().get("t") ?? "";
  const [preview, setPreview] = useState<LeadLinkPreview | null>(null);
  const [done, setDone] = useState<LeadStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) return;
    previewLeadLink(token)
      .then(setPreview)
      .catch(() => setError("This link has expired or isn't valid. Open your leads in AdVault instead."));
  }, [token]);

  async function apply() {
    setBusy(true);
    try {
      setDone((await applyLeadLink(token)).status);
    } catch {
      setError("Couldn't save that. Try again, or open your leads in AdVault.");
    } finally {
      setBusy(false);
    }
  }

  const leadsLink = (
    <Link href="/dashboard/leads" className="text-amber-300 underline">
      See all your leads
    </Link>
  );

  const shown = token ? error : "This link is missing its code.";
  if (shown) {
    return (
      <Card>
        <CardTitle>Booking request</CardTitle>
        <CardDescription>{shown}</CardDescription>
        <p className="mt-4 text-sm">{leadsLink}</p>
      </Card>
    );
  }
  if (!preview) return <p className="text-sm text-zinc-400">Loading…</p>;

  const confirm = preview.action === "confirm";
  const what = `${preview.service ?? "Booking"}${preview.when ? `, ${preview.when}` : ""}`;
  const finalStatus = done ?? (preview.status === (confirm ? "confirmed" : "declined") ? preview.status : null);

  return (
    <Card>
      <CardTitle>{preview.name}&apos;s booking</CardTitle>
      <CardDescription>{what}</CardDescription>
      {finalStatus ? (
        <p className="mt-4 text-sm text-emerald-300" role="status">
          {finalStatus === "confirmed"
            ? "Confirmed. We've let them know if they left an email."
            : finalStatus === "declined"
              ? "Declined. We've let them know if they left an email."
              : "This booking is already marked done."}
        </p>
      ) : (
        <div className="mt-4">
          <Button onClick={apply} disabled={busy} variant={confirm ? "default" : "outline"}>
            {busy ? "Saving…" : confirm ? "Confirm this booking" : "Decline this booking"}
          </Button>
        </div>
      )}
      <p className="mt-4 text-sm">{leadsLink}</p>
    </Card>
  );
}

export default function LeadActionPage() {
  return (
    <main className="mx-auto w-full max-w-md px-4 py-16 sm:px-6">
      <Suspense fallback={<p className="text-sm text-zinc-400">Loading…</p>}>
        <Action />
      </Suspense>
    </main>
  );
}

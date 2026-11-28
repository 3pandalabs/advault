"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ApiError,
  getLeadReviewLinks,
  listLeads,
  requestLeadReview,
  setLeadStatus,
  type Lead,
  type LeadKind,
  type LeadStatus,
} from "@/lib/api/browser";
import { Badge, Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

// Leads (2026-11-27, api routes/leads.ts): "Request a quote", "Call me back"
// and booking requests sent from the owner's SiteVault website. Tap to call or
// email, change the status, confirm or decline bookings, and ask a happy
// customer for a review (the link comes from the website's settings).

const KIND_LABEL: Record<LeadKind, string> = { quote: "Quote", callback: "Call back", booking: "Booking" };
const STATUS_LABEL: Record<LeadStatus, string> = {
  new: "New",
  requested: "Waiting for you",
  contacted: "Contacted",
  confirmed: "Confirmed",
  declined: "Declined",
  done: "Done",
};
const STATUS_TONE: Record<LeadStatus, "pending" | "neutral" | "success" | "danger"> = {
  new: "pending",
  requested: "pending",
  contacted: "neutral",
  confirmed: "success",
  declined: "danger",
  done: "neutral",
};

function when(b: NonNullable<Lead["booking"]>): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: b.timezone,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(b.start));
  } catch {
    return new Date(b.start).toLocaleString();
  }
}

const select =
  "h-9 rounded-lg border border-white/15 bg-white/5 px-2 text-sm text-zinc-100 focus:border-amber-400/60 focus:outline-none";

export default function LeadsPage() {
  const [leads, setLeads] = useState<Lead[] | null>(null);
  const [kind, setKind] = useState<LeadKind | "">("");
  const [status, setStatus] = useState<LeadStatus | "">("");
  const [error, setError] = useState<string | null>(null);
  const [reviewLinks, setReviewLinks] = useState<Record<string, string | null>>({});

  const [rev, setRev] = useState(0);
  const load = useCallback(() => {
    setError(null);
    setRev((n) => n + 1);
  }, []);

  useEffect(() => {
    let live = true;
    listLeads({ kind: kind || undefined, status: status || undefined })
      .then((r) => live && setLeads(r.leads))
      .catch(() => live && setError("Couldn't load your leads right now."));
    return () => {
      live = false;
    };
  }, [kind, status, rev]);

  useEffect(() => {
    getLeadReviewLinks()
      .then((r) => setReviewLinks(r.links))
      .catch(() => setReviewLinks({}));
  }, []);

  function replace(l: Lead) {
    setLeads((list) => (list ?? []).map((x) => (x.id === l.id ? l : x)));
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Leads</h1>
        <p className="mt-1 text-sm text-zinc-400">
          Quote requests, call-backs and bookings from your website. We email you each one as it arrives.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <select aria-label="Kind" className={select} value={kind} onChange={(e) => setKind(e.target.value as LeadKind | "")}>
          <option value="" className="bg-zinc-900">All kinds</option>
          {(Object.keys(KIND_LABEL) as LeadKind[]).map((k) => (
            <option key={k} value={k} className="bg-zinc-900">
              {KIND_LABEL[k]}
            </option>
          ))}
        </select>
        <select aria-label="Status" className={select} value={status} onChange={(e) => setStatus(e.target.value as LeadStatus | "")}>
          <option value="" className="bg-zinc-900">Any status</option>
          {(Object.keys(STATUS_LABEL) as LeadStatus[]).map((s) => (
            <option key={s} value={s} className="bg-zinc-900">
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
      </div>

      {error && (
        <Card>
          <CardDescription>{error}</CardDescription>
          <div className="mt-3">
            <Button size="sm" onClick={load}>
              Try again
            </Button>
          </div>
        </Card>
      )}
      {!error && leads === null && <p className="text-sm text-zinc-500">Loading…</p>}
      {!error && leads?.length === 0 && (
        <Card>
          <CardTitle>No leads yet</CardTitle>
          <CardDescription>
            When someone asks for a quote, a call back or a booking on your website, it shows up here and in your email.
          </CardDescription>
        </Card>
      )}
      {leads?.map((l) => (
        <LeadCard key={l.id} lead={l} reviewUrl={reviewLinks[l.siteSlug] ?? null} onChange={replace} />
      ))}
    </div>
  );
}

function LeadCard({ lead, reviewUrl, onChange }: { lead: Lead; reviewUrl: string | null; onChange: (l: Lead) => void }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function move(s: LeadStatus) {
    setBusy(true);
    setNote(null);
    try {
      onChange((await setLeadStatus(lead.id, s)).lead);
      if (lead.kind === "booking" && (s === "confirmed" || s === "declined") && lead.email) {
        setNote(s === "confirmed" ? "Confirmed. We emailed them." : "Declined. We emailed them.");
      }
    } catch {
      setNote("Couldn't save that. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function askReview() {
    setBusy(true);
    setNote(null);
    try {
      await requestLeadReview(lead.id);
      onChange({ ...lead, reviewRequestedAt: new Date().toISOString() });
      setNote("Review request sent.");
    } catch (e) {
      setNote(
        e instanceof ApiError && e.code === "review_already_requested"
          ? "You already asked this customer."
          : e instanceof ApiError && e.code === "no_review_link"
            ? "Add your review link on your website first."
            : "Couldn't send it right now.",
      );
    } finally {
      setBusy(false);
    }
  }

  const isBooking = lead.kind === "booking" && lead.booking;
  const canReview = Boolean(lead.email) && !lead.reviewRequestedAt;

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2">
        <Badge>{KIND_LABEL[lead.kind]}</Badge>
        <Badge tone={STATUS_TONE[lead.status]}>{STATUS_LABEL[lead.status]}</Badge>
        {lead.campaignId && <Badge tone="success">From your ad</Badge>}
        <span className="ml-auto text-xs text-zinc-500">{new Date(lead.createdAt).toLocaleString()}</span>
      </div>
      <p className="mt-2 text-base font-semibold text-zinc-100">{lead.name}</p>
      {isBooking && (
        <p className="text-sm text-amber-200">
          {lead.booking!.service}, {when(lead.booking!)} ({lead.booking!.durationMin} min)
        </p>
      )}
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm">
        <a href={`tel:${lead.phone.replace(/[^\d+]/g, "")}`} className="text-amber-300 underline">
          Call {lead.phone}
        </a>
        <a href={`sms:${lead.phone.replace(/[^\d+]/g, "")}`} className="text-amber-300 underline">
          Text
        </a>
        {lead.email && (
          <a href={`mailto:${lead.email}`} className="break-all text-amber-300 underline">
            {lead.email}
          </a>
        )}
      </div>
      {lead.bestTime && <p className="mt-1 text-xs text-zinc-400">Best time: {lead.bestTime}</p>}
      {lead.message && <p className="mt-2 whitespace-pre-wrap text-sm text-zinc-300">{lead.message}</p>}
      {lead.photoUrls.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {lead.photoUrls.map((u, i) => (
            <a key={u} href={u} target="_blank" rel="noopener noreferrer" className="text-xs text-amber-300 underline">
              Photo {i + 1}
            </a>
          ))}
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        {isBooking && lead.status !== "confirmed" && lead.status !== "done" && (
          <Button size="sm" onClick={() => move("confirmed")} disabled={busy}>
            Confirm
          </Button>
        )}
        {isBooking && lead.status !== "declined" && lead.status !== "done" && (
          <Button size="sm" variant="outline" onClick={() => move("declined")} disabled={busy}>
            Decline
          </Button>
        )}
        {(lead.status === "new" || lead.status === "requested") && (
          <Button size="sm" variant="outline" onClick={() => move("contacted")} disabled={busy}>
            Mark contacted
          </Button>
        )}
        {lead.status !== "done" && (
          <Button size="sm" variant="ghost" onClick={() => move("done")} disabled={busy}>
            Mark done
          </Button>
        )}
        {lead.email && (
          <Button size="sm" variant="ghost" onClick={askReview} disabled={busy || !canReview || !reviewUrl}>
            {lead.reviewRequestedAt ? "Review asked" : "Ask for a review"}
          </Button>
        )}
      </div>
      {lead.email && !reviewUrl && !lead.reviewRequestedAt && (
        <p className="mt-1 text-xs text-zinc-500">To ask for reviews, add your Google review link on your website&apos;s settings.</p>
      )}
      {note && (
        <p className="mt-2 text-xs text-zinc-300" role="status">
          {note}
        </p>
      )}
    </Card>
  );
}

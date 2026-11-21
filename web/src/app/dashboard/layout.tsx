"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { backToAdmin, clearTokens, getMe, getTokens, setTestAsCustomer, type Me } from "@/lib/api/browser";
import { TEST_PRICE_DISPLAY } from "@/lib/testMode";
import { WordmarkName, WordmarkTag } from "@/components/Wordmark";
import { Button } from "@/components/ui/button";
import { acceptTerms, type TermsState } from "@/lib/api/compliance";

// The dashboard is client-rendered and talks to the API directly from the
// browser rather than through Server Components. Two reasons:
//   - it sidesteps the orange-to-orange restriction entirely (see
//     wrangler.jsonc) — no server-side fetch, no DNS-only hostname needed;
//   - the API is the only real authorization boundary anyway, so putting a
//     rendering layer in front of it buys nothing but a second place for the
//     auth check to be subtly wrong.
//
// This layout's redirect is convenience, not security. Every route below it is
// enforced by the API's requireAuth; a user who defeats this check reaches an
// API that answers 401.
export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    if (!getTokens().access) {
      router.replace("/login");
      return;
    }
    getMe()
      .then(setMe)
      .catch(() => {
        clearTokens();
        router.replace("/login");
      })
      .finally(() => setChecked(true));
  }, [router]);

  const [turningOff, setTurningOff] = useState(false);
  // Admin "Test as customer": switch back from the banner on any page.
  async function turnOffTestMode() {
    setTurningOff(true);
    try {
      await setTestAsCustomer(false);
      window.location.reload();
    } catch {
      setTurningOff(false);
    }
  }

  // Inside an admin's test customer: swap the session back to the admin.
  async function leaveTestCustomer() {
    setTurningOff(true);
    try {
      await backToAdmin();
      window.location.href = "/dashboard";
    } catch {
      setTurningOff(false);
    }
  }

  function signOut() {
    clearTokens();
    router.replace("/login");
  }

  if (!checked) {
    return <div className="px-6 py-16 text-center text-sm text-zinc-500">Loading…</div>;
  }

  // Terms of Service gate (api lib/compliance): a user who has not accepted
  // the current version sees only this until they do; the API refuses order,
  // generate and launch with 409 terms_not_accepted anyway. Admins too. An
  // older API without `terms` never blocks.
  const terms = (me as (Me & { terms?: TermsState }) | null)?.terms;
  if (me && terms && !terms.ok) {
    return (
      <TermsGate
        terms={terms}
        onAccepted={(t) => setMe({ ...me, terms: t } as Me)}
        onSignOut={signOut}
      />
    );
  }

  return (
    <div>
      <header className="border-b border-white/10">
        {/* Phones (the Android app is this page at ~360px): wordmark on its own
            row, links wrap below it. One unwrapped row was ~680px wide and hid
            Settings and Sign out off-screen. */}
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-2 px-6 py-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="whitespace-nowrap text-lg font-semibold tracking-tight">
            <Link href="/dashboard">
              <WordmarkName />
            </Link>
            <WordmarkTag />
          </div>
          <nav className="-mx-3 flex flex-wrap items-center gap-1 text-sm lg:mx-0">
            <Link
              href="/dashboard"
              className="rounded-lg px-3 py-2 text-zinc-300 hover:bg-white/10"
            >
              Campaigns
            </Link>
            <Link
              href="/dashboard/website"
              className="rounded-lg px-3 py-2 text-zinc-300 hover:bg-white/10"
            >
              Website
            </Link>
            {/* "This month" (/dashboard/offer) is hidden: monthly offers belong to
                the offer/managed plans, which aren't sold right now (only Keep it
                running, which has no offers). The page still works by URL. */}
            {/* "Video bundle" (/dashboard/cinematic) is hidden: sales paused
                2026-11-15, see api/src/routes/cinematic.ts. The page still
                works by URL for anyone with past orders or pack credits. */}
            <Link
              href="/dashboard/subscription"
              className="rounded-lg px-3 py-2 text-zinc-300 hover:bg-white/10"
            >
              Subscription
            </Link>
            <Link
              href="/dashboard/wallet"
              className="rounded-lg px-3 py-2 text-zinc-300 hover:bg-white/10"
            >
              Balance
            </Link>
            {/* The cost simulator (was a fold on the campaign list). Short
                label on phones so the wrapped rows stay compact. */}
            <Link
              href="/dashboard/costs"
              className="rounded-lg px-3 py-2 text-zinc-300 hover:bg-white/10"
            >
              <span className="sm:hidden">Costs</span>
              <span className="hidden sm:inline">What it costs</span>
            </Link>
            {me?.role === "admin" && (
              <Link
                href="/dashboard/admin"
                className="rounded-lg px-3 py-2 text-amber-300 hover:bg-white/10"
              >
                Admin
              </Link>
            )}
            <Link
              href="/dashboard/settings"
              className="rounded-lg px-3 py-2 text-zinc-300 hover:bg-white/10"
            >
              Settings
            </Link>
            <Button variant="ghost" size="sm" onClick={signOut}>
              Sign out
            </Button>
          </nav>
        </div>
        {(me?.businessName || me?.isInternal) && (
          <div className="mx-auto w-full max-w-5xl px-6 pb-3 text-xs text-zinc-500">
            {me.businessName}
            {me.isInternal && (
              <span className="ml-2 rounded-full border border-sky-400/30 bg-sky-400/10 px-2 py-0.5 text-sky-200">
                Internal{me.internalLabel ? ` · ${me.internalLabel}` : ""}
              </span>
            )}
          </div>
        )}
      </header>
      {me?.isTestCustomer && (
        <div className="border-b border-amber-400/30 bg-amber-400/10">
          <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-2 px-6 py-2 text-sm text-amber-200">
            <span>
              Testing as {me.businessName ?? me.displayName ?? "a test customer"} (test customer). Charges are{" "}
              {TEST_PRICE_DISPLAY}; launch is a dry run.
            </span>
            <Button variant="outline" size="sm" onClick={leaveTestCustomer} disabled={turningOff}>
              {turningOff ? "Switching…" : "Back to admin"}
            </Button>
          </div>
        </div>
      )}
      {me?.testAsCustomer && me.role === "admin" && (
        <div className="border-b border-amber-400/30 bg-amber-400/10">
          <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-2 px-6 py-2 text-sm text-amber-200">
            <span>Testing as a customer — every charge is {TEST_PRICE_DISPLAY}.</span>
            <Button variant="outline" size="sm" onClick={turnOffTestMode} disabled={turningOff}>
              {turningOff ? "Turning off…" : "Turn off"}
            </Button>
          </div>
        </div>
      )}
      <main className="mx-auto w-full max-w-5xl px-6 py-8">{children}</main>
    </div>
  );
}

function TermsGate({
  terms,
  onAccepted,
  onSignOut,
}: {
  terms: TermsState;
  onAccepted: (t: TermsState) => void;
  onSignOut: () => void;
}) {
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function accept() {
    setBusy(true);
    setError(null);
    try {
      const res = await acceptTerms(terms.current);
      onAccepted(res.terms);
    } catch {
      setError("Could not save that. Please reload the page and try again.");
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto w-full max-w-lg px-4 py-16 sm:px-6">
      <div className="mb-8 text-center text-lg font-semibold tracking-tight">
        <WordmarkName />
        <WordmarkTag />
      </div>
      <div className="rounded-2xl border border-white/10 bg-white/5 p-6">
        <h1 className="text-xl font-semibold">
          {terms.accepted ? "We've updated our Terms" : "Please accept our Terms"}
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-zinc-400">
          Before you make, pay for or launch an ad, please read and accept our Terms of Service and
          Content Policy. They say that the claims in your ads must be true, that you need the rights
          to your photos and videos, and that we may remove ads that break the rules.
        </p>
        <p className="mt-3 text-sm">
          <Link href="/terms" target="_blank" className="text-amber-300 underline">
            Terms of Service
          </Link>
          {" · "}
          <Link href="/content-policy" target="_blank" className="text-amber-300 underline">
            Content Policy
          </Link>
          {" · "}
          <Link href="/privacy" target="_blank" className="text-amber-300 underline">
            Privacy Policy
          </Link>
        </p>
        <label className="mt-5 flex items-start gap-2 text-sm text-zinc-300">
          <input
            type="checkbox"
            className="mt-1 h-4 w-4 shrink-0 accent-amber-400"
            checked={agreed}
            onChange={(e) => setAgreed(e.target.checked)}
            disabled={busy}
          />
          <span>I agree to the Terms of Service and the Content Policy.</span>
        </label>
        {error && <p className="mt-3 text-sm text-red-300">{error}</p>}
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <Button onClick={accept} disabled={!agreed || busy}>
            {busy ? "Saving…" : "Accept and continue"}
          </Button>
          <Button variant="ghost" onClick={onSignOut} disabled={busy}>
            Sign out
          </Button>
        </div>
      </div>
    </main>
  );
}

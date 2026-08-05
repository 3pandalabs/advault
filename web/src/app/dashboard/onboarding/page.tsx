"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  adAccountBillingStatus,
  billingOptions,
  listAdAccounts,
  provisionManagedAccount,
  resendBillingInvite,
  type AdAccount,
  type BillingMode,
  type BillingOptions,
  type BillingStatus,
} from "@/lib/api/browser";
import { Badge, Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

// Ad account setup — the onboarding branch.
//
// Two shapes, one discriminator. The advertiser sees the choice only when this
// deployment offers both; with one mode configured there is nothing to ask and
// this page goes straight to provisioning.
//
// The part worth understanding before editing: for a customer-funded account,
// accepting access and entering a card happen in GOOGLE'S UI, and we can
// neither do them nor be notified when they finish. There is no API that adds a
// payment method. All this page can do is send the advertiser to the right
// place and poll until a billing setup appears on the account.
//
// Do not add a "mark as done" button. A self-reported yes produces a campaign
// that launches successfully and then never serves — the advertiser believes
// they are live, and nothing in the system disagrees. An honest blocked state
// is strictly better.

const POLL_MS = 5000;

type Phase = "loading" | "choose" | "provisioning" | "linking" | "done" | "unavailable";

export default function OnboardingPage() {
  const router = useRouter();
  const [options, setOptions] = useState<BillingOptions | null>(null);
  const [account, setAccount] = useState<AdAccount | BillingStatus | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [invitationSent, setInvitationSent] = useState<boolean | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  function needsLinking(a: AdAccount): boolean {
    return a.isManaged && a.billingMode === "customer" && a.billingLinkStatus !== "active";
  }

  const provision = useCallback(
    async (mode: BillingMode, offered: BillingOptions | null) => {
      setBusy(true);
      setError(null);
      setPhase("provisioning");
      try {
        const created = await provisionManagedAccount(mode);
        setAccount(created);
        if (typeof created.invitationSent === "boolean") setInvitationSent(created.invitationSent);

        if (created.billingWarning === "mcc_has_no_payments_account") {
          // An operator problem, not this advertiser's. Say so plainly rather
          // than blaming their setup: every platform signup fails identically
          // until someone adds a card to the manager account.
          setError(
            "Your ad account was created, but AdVault's own billing is not set up yet. We have been notified — there is nothing more for you to do here.",
          );
          setPhase("done");
          return;
        }

        setPhase(needsLinking(created) ? "linking" : "done");
      } catch (err) {
        const code = err instanceof Error ? err.message : "";
        setError(
          code.includes("mcc_not_configured")
            ? "Ad account creation is not switched on for this deployment yet."
            : "We could not create your ad account. Please try again.",
        );
        setPhase(offered?.prompt ? "choose" : "unavailable");
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  // An existing account wins over the choice screen. Re-provisioning would
  // create a second child at Google and split the advertiser's campaigns across
  // two accounts, only one of which this dashboard would ever show.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [opts, existing] = await Promise.all([billingOptions(), listAdAccounts()]);
        if (cancelled) return;
        setOptions(opts);

        const managed = existing.accounts.find((a) => a.isManaged && a.status === "active");
        if (managed) {
          setAccount(managed);
          setPhase(needsLinking(managed) ? "linking" : "done");
          return;
        }

        if (opts.modes.length === 0) {
          setPhase("unavailable");
          return;
        }
        if (opts.prompt) {
          setPhase("choose");
          return;
        }
        // Exactly one mode offered, so there is no question to ask.
        await provision(opts.modes[0], opts);
      } catch {
        if (!cancelled) setError("Could not load your account setup. Please refresh.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [provision]);

  useEffect(() => stopPolling, [stopPolling]);

  // Poll only while something can still change. Google gives us no callback for
  // either the invitation or the card, so this is the only signal available.
  const accountId = account?.id;
  useEffect(() => {
    if (phase !== "linking" || !accountId) return;
    stopPolling();

    const tick = async () => {
      try {
        const status = await adAccountBillingStatus(accountId);
        setAccount(status);
        if (!status.polling || status.billingConfigured) {
          stopPolling();
          setPhase("done");
        }
      } catch {
        // A failed poll is not worth surfacing: the next one is five seconds
        // away and the page still shows the last known state.
      }
    };

    void tick();
    pollRef.current = setInterval(tick, POLL_MS);
    return stopPolling;
  }, [phase, accountId, stopPolling]);

  async function resend() {
    if (!account) return;
    setBusy(true);
    try {
      const res = await resendBillingInvite(account.id);
      setAccount(res);
      setInvitationSent(res.invitationSent);
    } catch {
      setError("We could not resend the invitation. Please try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-semibold tracking-tight">Set up your ad account</h1>
      <p className="mt-2 text-sm text-zinc-400">
        This happens once. After it, everything — new videos, budgets, reporting — stays in AdVault.
      </p>

      {error && (
        <p className="mt-4 rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2 text-sm text-red-200">
          {error}
        </p>
      )}

      {phase === "loading" && <p className="mt-6 text-sm text-zinc-500">Loading…</p>}

      {phase === "unavailable" && (
        <Card className="mt-6">
          <CardTitle>Not switched on yet</CardTitle>
          <CardDescription>
            Ad account creation needs a Google Ads developer token, which is a manual review on
            Google&apos;s side. Everything else — uploads, scripts, rendering — works normally, and
            your videos are yours to download in the meantime.
          </CardDescription>
        </Card>
      )}

      {phase === "choose" && (
        <div className="mt-6 grid gap-4 md:grid-cols-2">
          <Card>
            <CardTitle>We handle the ad spend</CardTitle>
            <CardDescription>
              AdVault pays Google, and bills you for your ad budget alongside your plan — on one
              invoice that shows the two separately.
            </CardDescription>
            <ul className="mt-4 space-y-2 text-sm text-zinc-400">
              <li>About 6 minutes to set up</li>
              <li>One step in Google, to connect your business</li>
              <li>You keep a balance topped up with us</li>
            </ul>
            <Button
              className="mt-5 w-full"
              disabled={busy}
              onClick={() => provision("platform", options)}
            >
              Use this
            </Button>
          </Card>

          <Card>
            <CardTitle>I&apos;ll pay Google directly</CardTitle>
            <CardDescription>
              Your own card sits on your ad account. Google bills you for ad spend, we bill you for
              the plan, and there is no balance to keep topped up.
            </CardDescription>
            <ul className="mt-4 space-y-2 text-sm text-zinc-400">
              <li>About 10 minutes to set up</li>
              <li>Three steps in Google, including entering a card</li>
              <li>Lower monthly cost from us</li>
            </ul>
            <Button
              className="mt-5 w-full"
              variant="outline"
              disabled={busy}
              onClick={() => provision("customer", options)}
            >
              Use this
            </Button>
          </Card>
        </div>
      )}

      {phase === "provisioning" && (
        <Card className="mt-6">
          <CardTitle>Creating your ad account…</CardTitle>
          <CardDescription>
            This takes a few seconds. Please don&apos;t close the page.
          </CardDescription>
        </Card>
      )}

      {phase === "linking" && account && (
        <Card className="mt-6">
          <div className="flex items-center justify-between gap-3">
            <CardTitle>Two steps left, in Google</CardTitle>
            <Badge tone="pending">
              {account.billingLinkStatus === "invited" ? "Invitation sent" : "Preparing"}
            </Badge>
          </div>
          <CardDescription>
            Your ad account is created. Google needs you to accept access to it and add a payment
            method — that part has to happen on their site, and we can&apos;t do it for you.
          </CardDescription>

          <ol className="mt-5 space-y-4 text-sm">
            <li className="rounded-lg border border-white/10 bg-white/[0.03] p-4">
              <p className="font-medium text-zinc-200">1. Accept the invitation</p>
              <p className="mt-1 text-zinc-400">
                {invitationSent === false
                  ? "We could not send the invitation email. Try resending it."
                  : "Google emailed an invitation to your address. Check spam if it hasn't arrived — that is the most common place it ends up."}
              </p>
              <Button className="mt-3" variant="outline" disabled={busy} onClick={resend}>
                Resend invitation
              </Button>
            </li>

            <li className="rounded-lg border border-white/10 bg-white/[0.03] p-4">
              <p className="font-medium text-zinc-200">2. Add your card</p>
              <p className="mt-1 text-zinc-400">
                Do this after accepting the invitation. Your campaigns can&apos;t go live until
                Google has a payment method on the account.
              </p>
              {account.billingUrl && (
                <a
                  className="mt-3 inline-flex h-10 items-center rounded-lg bg-amber-400 px-4 text-sm font-medium text-zinc-950 transition-colors hover:bg-amber-300"
                  href={account.billingUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open Google billing
                </a>
              )}
            </li>
          </ol>

          <p className="mt-5 text-xs text-zinc-500">
            This page checks every few seconds and moves on by itself once Google confirms. You can
            leave and come back — nothing is lost.
          </p>
        </Card>
      )}

      {phase === "done" && account && (
        <Card className="mt-6">
          <div className="flex items-center justify-between gap-3">
            <CardTitle>Your ad account is ready</CardTitle>
            <Badge tone="success">
              {account.billingMode === "platform" ? "We pay Google" : "You pay Google"}
            </Badge>
          </div>
          <CardDescription>
            {account.billingMode === "platform"
              ? "Top up your balance and your campaigns can go live. We pause them automatically if the balance runs out, so nothing overspends."
              : "Google bills your card for ad spend. We bill you for your plan separately."}
          </CardDescription>
          <div className="mt-5 flex flex-wrap gap-3">
            <Button onClick={() => router.push("/dashboard/campaigns/new")}>
              Create your first ad
            </Button>
            {account.billingMode === "platform" && (
              <Button variant="outline" onClick={() => router.push("/dashboard/wallet")}>
                Top up balance
              </Button>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}

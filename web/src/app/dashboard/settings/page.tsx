"use client";

import { useEffect, useState } from "react";
import {
  disconnectAdAccount,
  googleAuthorizeUrl,
  listAdAccounts,
  type AdAccount,
} from "@/lib/api/browser";
import { Badge, Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/utils";

export default function SettingsPage() {
  const [data, setData] = useState<{ configured: boolean; accounts: AdAccount[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = () =>
    listAdAccounts()
      .then(setData)
      .catch(() => setError("Could not load your connected accounts."));

  useEffect(() => {
    refresh();
  }, []);

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      // The URL is built server-side so the client id and the exact redirect
      // URI live in one place — Google compares the whole redirect string, and
      // a client-side copy is drift waiting to happen.
      const { url } = await googleAuthorizeUrl();
      window.location.assign(url);
    } catch {
      setError("Could not start the Google connection. Please try again.");
      setBusy(false);
    }
  }

  async function disconnect(id: string) {
    setBusy(true);
    try {
      await disconnectAdAccount(id);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>

      {error && (
        <p className="mt-4 rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2 text-sm text-red-200">
          {error}
        </p>
      )}

      <Card className="mt-6">
        <CardTitle>Google Ads</CardTitle>
        <CardDescription>
          AdVault builds campaigns inside your own Google Ads account, so you keep the billing
          relationship, the history and the data. Every campaign is created paused — nothing
          spends until you enable it there.
        </CardDescription>

        {!data ? (
          <p className="mt-4 text-sm text-zinc-500">Loading…</p>
        ) : !data.configured ? (
          // Not an error state. The Google Ads developer token is a manual
          // review that can take days, so this is the expected state for a
          // freshly-deployed instance and reads as such.
          <p className="mt-4 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-zinc-400">
            Google Ads launching is not switched on for this deployment yet. Everything else —
            uploads, scripts, rendering — works normally, and your videos are yours to download
            and upload manually in the meantime.
          </p>
        ) : data.accounts.length === 0 ? (
          <div className="mt-4">
            <Button onClick={connect} disabled={busy}>
              {busy ? "Redirecting…" : "Connect Google Ads"}
            </Button>
            <p className="mt-3 text-xs text-zinc-500">
              You will be sent to Google to approve access. AdVault requests permission to create
              campaigns in the account you choose — there is no narrower Google Ads permission
              than that.
            </p>
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            {data.accounts.map((account) => (
              <div
                key={account.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/[0.02] p-3"
              >
                <div>
                  <p className="text-sm font-medium text-zinc-100">
                    {account.descriptiveName ?? "Google Ads account"}{" "}
                    <span className="font-mono text-xs text-zinc-500">{account.customerId}</span>
                  </p>
                  <p className="mt-0.5 text-xs text-zinc-500">
                    Connected {formatDate(account.connectedAt)}
                    {account.isTestAccount === "yes" && " · test account"}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {account.status === "revoked" ? (
                    <>
                      <Badge tone="danger">Reconnect needed</Badge>
                      <Button size="sm" onClick={connect} disabled={busy}>
                        Reconnect
                      </Button>
                    </>
                  ) : (
                    <Badge tone="success">Connected</Badge>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => disconnect(account.id)}
                  >
                    Disconnect
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card className="mt-4">
        <CardTitle>Password</CardTitle>
        <CardDescription>
          Password reset is not available yet. If you lose access to your account, contact
          support rather than creating a second one.
        </CardDescription>
      </Card>
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import {
  disconnectAdAccount,
  disconnectYouTubeChannel,
  getYouTubeChannel,
  googleAuthorizeUrl,
  listAdAccounts,
  youtubeAuthorizeUrl,
  type AdAccount,
  type YouTubeChannelStatus,
} from "@/lib/api/browser";
import { Badge, Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/utils";

export default function SettingsPage() {
  const [data, setData] = useState<{ configured: boolean; accounts: AdAccount[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [youtube, setYoutube] = useState<YouTubeChannelStatus | null>(null);

  const refresh = () =>
    listAdAccounts()
      .then(setData)
      .catch(() => setError("Could not load your connected accounts."));

  // Separate request and separate failure: not knowing which YouTube channel is
  // in effect must not blank out the ad accounts card, which is the one an
  // advertiser came here for.
  const refreshYoutube = () =>
    getYouTubeChannel()
      .then(setYoutube)
      .catch(() => undefined);

  useEffect(() => {
    refresh();
    refreshYoutube();
  }, []);

  async function connectYouTube() {
    setBusy(true);
    setError(null);
    try {
      const { url } = await youtubeAuthorizeUrl();
      window.location.assign(url);
    } catch {
      setError("Could not start the YouTube connection. Please try again.");
      setBusy(false);
    }
  }

  async function disconnectYouTube() {
    setBusy(true);
    try {
      await disconnectYouTubeChannel();
      await refreshYoutube();
    } finally {
      setBusy(false);
    }
  }

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
          AdVault builds every campaign inside a Google Ads account of your own, so you keep the
          history and the data. Who Google bills depends on how the account is set up — each one
          below says which. Every campaign is created paused; nothing spends until it is enabled.
        </CardDescription>

        {!data ? (
          <p className="mt-4 text-sm text-zinc-500">Loading…</p>
        ) : !data.configured ? (
          // Not an error state. Google Ads API access is granted per Google
          // Cloud project (developer tokens were sunset in September 2026) and
          // needs brand verification, so this is the expected state for a
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
                    {account.billingMode === "platform"
                      ? " · we pay Google, billed to your balance"
                      : " · you pay Google directly"}
                  </p>
                  {/* The one state an advertiser can act on: a managed account
                      they pay for, where Google has no card yet. Campaigns
                      cannot launch until this is finished, so it gets a link
                      rather than only a badge. */}
                  {account.isManaged &&
                    account.billingMode === "customer" &&
                    account.billingLinkStatus !== "active" && (
                      <a
                        className="mt-1 inline-block text-xs font-medium text-amber-300 underline underline-offset-2 hover:text-amber-200"
                        href="/dashboard/onboarding"
                      >
                        Finish adding your payment method
                      </a>
                    )}
                </div>
                <div className="flex items-center gap-2">
                  {account.isManaged &&
                    account.billingMode === "customer" &&
                    account.billingLinkStatus !== "active" && (
                      <Badge tone="pending">Billing incomplete</Badge>
                    )}
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
        <CardTitle>Where your ads are published</CardTitle>
        <CardDescription>
          A YouTube ad has to be a YouTube video, so every ad AdVault makes is published as an
          unlisted video before it can run. By default that happens on our channel and needs
          nothing from you. You can publish to your own channel instead if you would rather own
          the videos.
        </CardDescription>

        {!youtube ? (
          <p className="mt-4 text-sm text-zinc-500">Loading…</p>
        ) : (
          <div className="mt-4 space-y-3">
            {/* The state that matters most and is otherwise invisible: nothing
                can be published at all, so ads render and no campaign can ever
                serve. An operator problem, but the advertiser is the one who
                would otherwise sit waiting. */}
            {!youtube.uploadsPossible && (
              <p className="rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-sm text-amber-200">
                Publishing to YouTube is not switched on for this deployment yet, so campaigns
                cannot go live. Your videos still render and are yours to download.
              </p>
            )}

            {youtube.ownChannel && youtube.ownChannel.status === "active" ? (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/[0.02] p-3">
                <div>
                  <p className="text-sm font-medium text-zinc-100">
                    {youtube.ownChannel.title ?? "Your YouTube channel"}
                  </p>
                  <p className="mt-0.5 text-xs text-zinc-500">
                    Connected {formatDate(youtube.ownChannel.connectedAt)} · new ads publish here
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone="success">Your channel</Badge>
                  <Button variant="ghost" size="sm" disabled={busy} onClick={disconnectYouTube}>
                    Use our channel
                  </Button>
                </div>
              </div>
            ) : youtube.ownChannel?.status === "revoked" ? (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/[0.02] p-3">
                <div>
                  <p className="text-sm font-medium text-zinc-100">
                    {youtube.ownChannel.title ?? "Your YouTube channel"}
                  </p>
                  <p className="mt-0.5 text-xs text-zinc-500">
                    Access to your channel has lapsed, so new ads publish to our channel until you
                    reconnect.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone="danger">Reconnect needed</Badge>
                  <Button size="sm" onClick={connectYouTube} disabled={busy}>
                    Reconnect
                  </Button>
                </div>
              </div>
            ) : (
              <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
                <p className="text-sm text-zinc-300">
                  Publishing to{" "}
                  <span className="font-medium text-zinc-100">
                    {youtube.orgChannelTitle ?? "the AdVault channel"}
                  </span>
                  . Nothing to do — this is the default.
                </p>
                {youtube.canConnectOwnChannel && (
                  <>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button variant="outline" size="sm" onClick={connectYouTube} disabled={busy}>
                        {busy ? "Redirecting…" : "Use my own YouTube channel"}
                      </Button>
                    </div>
                    <p className="mt-2 text-xs text-zinc-500">
                      You will be sent to Google to approve uploading videos to your channel. Ads
                      already published stay on our channel — YouTube cannot move a video between
                      channels, so only new ads are affected.
                    </p>
                  </>
                )}
              </div>
            )}
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

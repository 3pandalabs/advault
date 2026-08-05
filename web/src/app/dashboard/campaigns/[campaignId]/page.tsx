"use client";

import Link from "next/link";
import { use, useCallback, useEffect, useState } from "react";
import {
  ApiError,
  creativeDownloadUrl,
  getCampaign,
  launchCampaign,
  listAdAccounts,
  retryCreative,
  type AdAccount,
  type Campaign,
  type Creative,
} from "@/lib/api/browser";
import { Badge, Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatDuration, formatMoney } from "@/lib/utils";

type Loaded = Campaign & { creatives: Creative[] };

// Maps the API's error codes to something an advertiser can act on. Anything
// unmapped falls through to the raw code rather than a generic message —
// a code is at least searchable, where "something went wrong" is not.
const LAUNCH_ERRORS: Record<string, string> = {
  google_ads_not_configured:
    "Google Ads launching is not switched on for this account yet. Everything else works — your videos are rendered and ready.",
  ad_account_revoked:
    "Your Google Ads connection expired. Reconnect it in Settings and try again.",
  no_ready_creatives: "Wait for at least one video to finish rendering first.",
  already_launched: "This campaign has already been sent to Google Ads.",
  no_resolvable_zip_codes: "Google did not recognise any of those ZIP codes.",
  // The wallet guard on accounts AdVault funds. Previously unmapped, so a 402
  // surfaced as the raw code.
  insufficient_funds:
    "Your balance is too low to cover this campaign. Top up on the Wallet page and try again.",
  // The billing gate. A campaign launched into an account with no payment
  // method succeeds at Google and then never serves, so this is refused rather
  // than allowed through.
  billing_not_configured:
    "Google still needs a payment method on this ad account. Finish the billing step in Settings, then launch.",
  billing_link_failed:
    "The Google account invitation could not be completed. Resend it from Settings, then launch.",
  provisioning_incomplete: "This ad account is still being set up. Try again in a moment.",
};

export default function CampaignDetailPage({
  params,
}: {
  params: Promise<{ campaignId: string }>;
}) {
  const { campaignId } = use(params);
  const [campaign, setCampaign] = useState<Loaded | null>(null);
  const [adAccounts, setAdAccounts] = useState<{ configured: boolean; accounts: AdAccount[] } | null>(
    null,
  );
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [launchNote, setLaunchNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(
    () => getCampaign(campaignId).then(setCampaign).catch(() => setError("Could not load this campaign.")),
    [campaignId],
  );

  useEffect(() => {
    refresh();
    listAdAccounts().then(setAdAccounts).catch(() => undefined);
  }, [refresh]);

  // Poll while anything is still encoding. The API returns 202 from the
  // generate call and the renderer works through a queue on a separate
  // container, so there is nothing to await — this is the progress indicator.
  // The interval clears itself as soon as nothing is pending, so a finished
  // campaign page makes no background requests at all.
  const pending = campaign?.creatives.some(
    (c) => c.renderStatus === "queued" || c.renderStatus === "rendering",
  );
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [pending, refresh]);

  // Preview URLs expire in ten minutes, so they are fetched per rendered
  // creative rather than stored.
  useEffect(() => {
    for (const c of campaign?.creatives ?? []) {
      if (!c.videoKey || previews[c.id]) continue;
      creativeDownloadUrl(c.videoKey)
        .then(({ url }) => setPreviews((p) => ({ ...p, [c.id]: url })))
        .catch(() => undefined);
    }
  }, [campaign, previews]);

  async function onLaunch(adAccountId: string) {
    setBusy(true);
    setError(null);
    setLaunchNote(null);
    try {
      const result = await launchCampaign(campaignId, adAccountId);
      setLaunchNote(
        `${result.note} Targeted ${result.zipCodesTargeted} of ${result.zipCodesRequested} ZIP codes.`,
      );
      await refresh();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "request_failed";
      setError(LAUNCH_ERRORS[code] ?? `Launch failed (${code}).`);
    } finally {
      setBusy(false);
    }
  }

  if (error && !campaign) return <p className="text-sm text-red-300">{error}</p>;
  if (!campaign) return <p className="text-sm text-zinc-500">Loading…</p>;

  const ready = campaign.creatives.filter((c) => c.renderStatus === "ready");
  const activeAccounts = adAccounts?.accounts.filter((a) => a.status === "active") ?? [];

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{campaign.name}</h1>
          <p className="mt-1 text-sm text-zinc-400">
            {formatMoney(campaign.dailyBudgetCents, campaign.currencyCode)}/day &middot;{" "}
            {campaign.targetZipCodes.join(", ")} within {campaign.radiusMiles} miles
          </p>
        </div>
        <Badge tone={campaign.status === "live" ? "success" : campaign.status === "failed" ? "danger" : "pending"}>
          {campaign.status}
        </Badge>
      </div>

      {error && (
        <p className="mb-4 rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2 text-sm text-red-200">
          {error}
        </p>
      )}
      {launchNote && (
        <p className="mb-4 rounded-lg border border-emerald-400/30 bg-emerald-400/10 px-3 py-2 text-sm text-emerald-200">
          {launchNote}
        </p>
      )}

      <div className="space-y-3">
        {campaign.creatives.map((creative) => (
          <Card key={creative.id}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <CardTitle>
                  {creative.aspectRatio === "9:16" ? "Shorts (9:16)" : "Pre-roll (16:9)"}
                </CardTitle>
                <CardDescription>
                  {creative.script?.hook ?? "Writing the script…"}
                  {creative.renderStatus === "ready" &&
                    ` · ${formatDuration(creative.durationSeconds)}`}
                </CardDescription>
              </div>
              <Badge
                tone={
                  creative.renderStatus === "ready"
                    ? "success"
                    : creative.renderStatus === "failed"
                      ? "danger"
                      : "pending"
                }
              >
                {creative.renderStatus === "queued"
                  ? "Queued"
                  : creative.renderStatus === "rendering"
                    ? "Rendering…"
                    : creative.renderStatus === "ready"
                      ? "Ready"
                      : "Failed"}
              </Badge>
            </div>

            {creative.renderStatus === "ready" && previews[creative.id] && (
              <video
                controls
                src={previews[creative.id]}
                className={`mt-4 rounded-lg border border-white/10 ${
                  creative.aspectRatio === "9:16" ? "max-h-96" : "w-full"
                }`}
              />
            )}

            {creative.renderStatus === "failed" && (
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <p className="text-sm text-red-300">{creative.renderError ?? "Rendering failed."}</p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => retryCreative(creative.id).then(refresh)}
                >
                  Try again
                </Button>
              </div>
            )}

            {creative.scriptSource === "fallback" && (
              // Surfaced rather than hidden: the advertiser should know the
              // copy came from a template so they can decide whether to edit
              // it, instead of wondering why it reads generically.
              <p className="mt-3 text-xs text-zinc-500">
                Written from a template — you can edit the wording before launching.
              </p>
            )}
          </Card>
        ))}
      </div>

      <Card className="mt-6">
        <CardTitle>Launch</CardTitle>
        {campaign.googleCampaignResourceName ? (
          <CardDescription>
            Sent to Google Ads. Open your Google Ads account to review it and switch it on — it
            was created paused and is not spending yet.
          </CardDescription>
        ) : adAccounts && !adAccounts.configured ? (
          <CardDescription>{LAUNCH_ERRORS.google_ads_not_configured}</CardDescription>
        ) : activeAccounts.length === 0 ? (
          <>
            <CardDescription>
              Connect your Google Ads account to launch this campaign. AdVault creates it paused
              — you switch it on yourself.
            </CardDescription>
            <div className="mt-4">
              <Link href="/dashboard/settings">
                <Button variant="outline">Connect Google Ads</Button>
              </Link>
            </div>
          </>
        ) : ready.length === 0 ? (
          <CardDescription>Waiting for at least one video to finish rendering.</CardDescription>
        ) : (
          <>
            <CardDescription>
              This creates a paused campaign in your Google Ads account with a{" "}
              {formatMoney(campaign.dailyBudgetCents, campaign.currencyCode)} daily budget. It
              does not start spending until you enable it there.
            </CardDescription>
            <div className="mt-4 flex flex-wrap gap-2">
              {activeAccounts.map((account) => (
                <Button key={account.id} disabled={busy} onClick={() => onLaunch(account.id)}>
                  {busy
                    ? "Launching…"
                    : `Launch to ${account.descriptiveName ?? account.customerId}`}
                </Button>
              ))}
            </div>
          </>
        )}
      </Card>
    </div>
  );
}

"use client";

import Link from "next/link";
import { use, useCallback, useEffect, useState } from "react";
import {
  ApiError,
  creativeDownloadUrl,
  getCampaign,
  getMe,
  isAwaitingPlatformSetup,
  launchCampaign,
  listAdAccounts,
  provisionManagedAccount,
  retryCreative,
  retryYouTubeUpload,
  type AdAccount,
  type Asset,
  type Campaign,
  type Creative,
} from "@/lib/api/browser";
import { SquareLogo } from "./square-logo";
import { AdminVideoUpload } from "./admin-video-upload";
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
  // A YouTube ad has to be a YouTube video. These two are the gap between
  // "rendered" and "can actually run", and until the upload queue existed the
  // launch simply succeeded without an ad in it.
  youtube_upload_pending:
    "Your ad is still being published to YouTube. Launch is available once that finishes — usually a minute or two.",
  youtube_upload_failed:
    "Your ad could not be published to YouTube, so Google has nothing to show. Try publishing again from the video below.",
  no_ads_attached:
    "The campaign reached Google but no ad could be attached to it, so it would not serve. Nothing is spending — try launching again.",
  // Google requires a square logo on every YouTube ad this app can create.
  logo_required: "Add your logo below first — Google needs one on every YouTube ad.",
  logo_invalid: "Your logo needs replacing — upload it again below and we'll fit it to a square.",
  manager_account:
    "That is a Google Ads manager account, which can't run campaigns itself. Set up an ad account under it instead.",
  billing_setup_pending:
    "We're finishing your ad account's setup. Launch unlocks automatically, usually within a few hours.",
  currency_mismatch:
    "This campaign's budget currency doesn't match the ad account's. Create the campaign again in the account's currency.",
  provisioning_failed: "We couldn't set up your ad account just now. Please try again in a few minutes.",
};

export default function CampaignDetailPage({
  params,
}: {
  params: Promise<{ campaignId: string }>;
}) {
  const { campaignId } = use(params);
  const [campaign, setCampaign] = useState<Loaded | null>(null);
  const [adAccounts, setAdAccounts] = useState<{
    configured: boolean;
    managedOffered?: boolean;
    accounts: AdAccount[];
  } | null>(null);
  const [settingUp, setSettingUp] = useState(false);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [launchNote, setLaunchNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [logo, setLogo] = useState<Asset | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);

  const refresh = useCallback(
    () => getCampaign(campaignId).then(setCampaign).catch(() => setError("Could not load this campaign.")),
    [campaignId],
  );

  useEffect(() => {
    refresh();
    listAdAccounts().then(setAdAccounts).catch(() => undefined);
    getMe().then((me) => setIsAdmin(me.role === "admin")).catch(() => undefined);
  }, [refresh]);

  // Poll while anything is still encoding. The API returns 202 from the
  // generate call and the renderer works through a queue on a separate
  // container, so there is nothing to await — this is the progress indicator.
  // The interval clears itself as soon as nothing is pending, so a finished
  // campaign page makes no background requests at all.
  // Publishing to YouTube counts as pending too. Without it the page stopped
  // polling the moment the encode finished and then sat there showing
  // "Publishing…" forever, with the Launch button withheld and no explanation.
  const pending = campaign?.creatives.some(
    (c) =>
      c.renderStatus === "queued" ||
      c.renderStatus === "rendering" ||
      (c.renderStatus === "ready" &&
        !c.youtubeVideoId &&
        c.youtubeUploadStatus !== "failed"),
  );
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [pending, refresh]);

  // While 3PandaLabs is adding the card to a new ad account, re-check once a
  // minute so Launch appears without a reload. The renderer polls Google every
  // five minutes; this only reads the result.
  const awaitingSetup = adAccounts?.accounts.some(isAwaitingPlatformSetup) ?? false;
  useEffect(() => {
    if (!awaitingSetup) return;
    const timer = setInterval(() => {
      listAdAccounts().then(setAdAccounts).catch(() => undefined);
    }, 60_000);
    return () => clearInterval(timer);
  }, [awaitingSetup]);

  // One click: AdVault creates and pays for the customer's Google Ads account.
  async function onSetUpAccount() {
    setSettingUp(true);
    setError(null);
    try {
      await provisionManagedAccount("platform", campaignId);
      setAdAccounts(await listAdAccounts());
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "request_failed";
      setError(LAUNCH_ERRORS[code] ?? `Setup failed (${code}).`);
    } finally {
      setSettingUp(false);
    }
  }

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
      // Google's own reason is more useful than the bare code, which is all
      // that showed before: "Launch failed (google_ads_error)".
      const detail = err instanceof ApiError ? err.detail : undefined;
      setError(
        LAUNCH_ERRORS[code] ??
          (code === "google_ads_error" && detail
            ? `Google Ads rejected the campaign: ${detail}`
            : `Launch failed (${code}).`),
      );
    } finally {
      setBusy(false);
    }
  }

  if (error && !campaign) return <p className="text-sm text-red-300">{error}</p>;
  if (!campaign) return <p className="text-sm text-zinc-500">Loading…</p>;

  // "Launchable" means rendered AND published to YouTube. Filtering on
  // renderStatus alone offered a Launch button for a campaign that would be
  // created at Google with no ad attached to it.
  const ready = campaign.creatives.filter(
    (c) => c.renderStatus === "ready" && c.youtubeVideoId,
  );
  const renderedNotPublished = campaign.creatives.filter(
    (c) => c.renderStatus === "ready" && !c.youtubeVideoId,
  );
  const activeAccounts = adAccounts?.accounts.filter((a) => a.status === "active") ?? [];
  // Accounts a campaign can go into right now. One still waiting for its card
  // gets the "being set up" message instead of a button that would 409.
  const launchableAccounts = activeAccounts.filter((a) => !isAwaitingPlatformSetup(a));
  const launchedAccount = adAccounts?.accounts.find((a) => a.id === campaign.adAccountId);
  const launchedForCustomer = launchedAccount?.billingMode === "platform";

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
                  {creative.kind === "upload"
                    ? "Uploaded video"
                    : (creative.script?.hook ?? "Writing the script…")}
                  {creative.renderStatus === "ready" &&
                    ` · ${formatDuration(creative.durationSeconds)}`}
                </CardDescription>
              </div>
              {/* Two separate facts, deliberately not collapsed into one
                  badge: a video can be rendered and still unable to run, and
                  reporting that as "Ready" is exactly how a campaign got
                  launched with no ad in it. "Ready" here means ready to run. */}
              <Badge
                tone={
                  creative.renderStatus === "failed" || creative.youtubeUploadStatus === "failed"
                    ? "danger"
                    : creative.renderStatus === "ready" && creative.youtubeVideoId
                      ? "success"
                      : "pending"
                }
              >
                {creative.renderStatus === "queued"
                  ? "Queued"
                  : creative.renderStatus === "rendering"
                    ? "Rendering…"
                    : creative.renderStatus === "failed"
                      ? "Failed"
                      : creative.youtubeUploadStatus === "failed"
                        ? "Not published"
                        : creative.youtubeVideoId
                          ? "Ready"
                          : "Publishing…"}
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

            {/* The publish step, surfaced only when it is the thing standing
                between a finished video and a runnable ad. A successful
                publish needs no mention — the badge already says Ready. */}
            {creative.renderStatus === "ready" && creative.youtubeUploadStatus === "failed" && (
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <p className="text-sm text-red-300">
                  {creative.youtubeUploadError
                    ? `Could not publish to YouTube: ${creative.youtubeUploadError}`
                    : "Could not publish this ad to YouTube, so it cannot run yet."}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => retryYouTubeUpload(creative.id).then(refresh)}
                >
                  Publish again
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

      {isAdmin && !campaign.googleCampaignResourceName && (
        <AdminVideoUpload campaignId={campaignId} onUploaded={refresh} />
      )}

      <Card className="mt-6">
        <CardTitle>Launch</CardTitle>
        {campaign.googleCampaignResourceName ? (
          <CardDescription>
            {launchedForCustomer
              ? "Your campaign is live. Google reviews new ads first, usually within a day, then they start showing in your area."
              : "Sent to Google Ads. Open your Google Ads account to review it and switch it on — it was created paused and is not spending yet."}
          </CardDescription>
        ) : adAccounts && !adAccounts.configured ? (
          <CardDescription>{LAUNCH_ERRORS.google_ads_not_configured}</CardDescription>
        ) : activeAccounts.length === 0 ? (
          adAccounts?.managedOffered ? (
            // The default path: the customer never needs a Google or YouTube
            // account. AdVault creates the ad account and pays Google for it.
            <>
              <CardDescription>
                AdVault runs your ads for you — no Google or YouTube account needed. We set up
                your ad account once, which usually takes a few hours.
              </CardDescription>
              <div className="mt-4">
                <Button disabled={settingUp} onClick={onSetUpAccount}>
                  {settingUp ? "Setting up…" : "Set up my ad account"}
                </Button>
              </div>
              {/* Deliberately no "connect your own Google Ads" link here: the
                  managed path is the product. Bring-your-own stays reachable
                  in Settings for the rare advertiser who insists. */}
            </>
          ) : (
            <>
              <CardDescription>
                Connect your Google Ads account to launch this campaign. AdVault creates the
                campaign paused — you switch it on yourself.
              </CardDescription>
              <div className="mt-4">
                <Link href="/dashboard/settings">
                  <Button variant="outline">Connect Google Ads</Button>
                </Link>
              </div>
            </>
          )
        ) : launchableAccounts.length === 0 ? (
          <CardDescription>
            We&apos;re setting up your ad account — nothing for you to do. Launch unlocks here
            automatically, usually within a few hours.
          </CardDescription>
        ) : ready.length === 0 ? (
          // Distinguishes the two waits, because they have different answers:
          // rendering finishes on its own, whereas a failed publish needs the
          // "Publish again" button on the video above.
          <CardDescription>
            {renderedNotPublished.length > 0
              ? renderedNotPublished.some((c) => c.youtubeUploadStatus === "failed")
                ? "Your video is rendered but could not be published to YouTube, so there is nothing for Google to show yet. Publish it again above."
                : "Your video is rendered and is being published to YouTube. Launch unlocks as soon as that finishes."
              : "Waiting for at least one video to finish rendering."}
          </CardDescription>
        ) : (
          <>
            <CardDescription>
              {launchableAccounts.some((a) => a.billingMode === "platform")
                ? `Launching starts your ads with a ${formatMoney(campaign.dailyBudgetCents, campaign.currencyCode)} daily budget, paid from your AdVault balance. Google reviews new ads first, usually within a day.`
                : `This creates a paused campaign in your Google Ads account with a ${formatMoney(campaign.dailyBudgetCents, campaign.currencyCode)} daily budget. It does not start spending until you enable it there.`}
            </CardDescription>
            <SquareLogo onChange={setLogo} />
            <div className="mt-4 flex flex-wrap gap-2">
              {launchableAccounts.map((account) => (
                <Button
                  key={account.id}
                  disabled={busy || !logo}
                  onClick={() => onLaunch(account.id)}
                >
                  {busy
                    ? "Launching…"
                    : account.billingMode === "platform"
                      ? "Launch my ads"
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

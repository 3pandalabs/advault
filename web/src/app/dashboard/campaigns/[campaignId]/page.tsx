"use client";

import { siteVaultSlug } from "@/lib/sitevault";
import Link from "next/link";
import { use, useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  creativeDownloadUrl,
  getCampaign,
  getWallet,
  generatePaidNewAd,
  getMe,
  getNewAdStatus,
  getSubscription,
  orderNewAd,
  pauseCampaign,
  resumeCampaign,
  setPlanChoice,
  subscribe,
  pushFreeSiteOffer,
  redoAd,
  type NewAdStatus,
  isAwaitingPlatformSetup,
  launchCampaign,
  listAdAccounts,
  provisionManagedAccount,
  retryCreative,
  removeUploadedCreative,
  retryYouTubeUpload,
  type AdAccount,
  type Asset,
  type Campaign,
  type Creative,
  type Wallet,
} from "@/lib/api/browser";
import { AdBudgetCard } from "./ad-budget-card";
import { BudgetBanner } from "@/components/BudgetBanner";
import { SquareLogo } from "./square-logo";
import { VideoUpload } from "./video-upload";
import { AttestationChecks, useAttestation } from "@/components/AttestationChecks";
import { ResultsCard } from "./results-card";
import { AudienceCard } from "./audience-card";
import { ScheduleCard } from "./schedule-card";
import { BudgetEditor } from "./budget-editor";
import { BUDGET_BELOW_MINIMUM_MESSAGE, minDailyBudgetCents, runLengthLabel, wizardTopupKey } from "@/lib/budget";
import { MONTHLY_AD_BUDGET_CENTS, monthlyTotalCents, oneMonthFromToday } from "@/lib/prices";
import { TopUpPicker } from "@/components/TopUpPicker";
import { WebsiteCard } from "./website-card";
import { BeforeAfterCard } from "./before-after-card";
import { SeasonCard } from "./season-card";
import { DetailsCard } from "./details-card";
import { OfferCard } from "./offer-card";
import { ChangeOfferCard } from "./change-offer-card";
import { WhatsAppPrompt } from "@/components/WhatsAppOptIn";
import { BadgesCard } from "./badges-card";
import { ExtrasCard } from "./extras-card";
import { SiteOfferOption, payLabel } from "./site-offer-option";
import { RenderProgress, ScriptProgress } from "./render-progress";
import { AUDIENCE_FILTERS_ENABLED } from "@/lib/audience";
import { Badge, Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatDate, formatDuration, formatMoney } from "@/lib/utils";
import { actsAsAdmin } from "@/lib/testMode";
import { PlanPriceLines } from "@/components/PlanPriceLines";

// "Writing the script" survives a refresh: sessionStorage, ignored after 2 min.
const WRITING_MAX_MS = 120_000;
const nowMs = () => Date.now();
function readWriting(campaignId: string): number | null {
  try {
    const t = Number(window.sessionStorage.getItem(`advault:writing:${campaignId}`));
    return t && nowMs() - t < WRITING_MAX_MS ? t : null;
  } catch {
    return null;
  }
}
function saveWriting(campaignId: string, t: number | null) {
  try {
    const k = `advault:writing:${campaignId}`;
    if (t === null) window.sessionStorage.removeItem(k);
    else window.sessionStorage.setItem(k, String(t));
  } catch {
    /* private mode: progress just won't survive a refresh */
  }
}

type Loaded = Campaign & { creatives: Creative[] };

// Maps the API's error codes to something an advertiser can act on. Anything
// unmapped falls through to the raw code rather than a generic message —
// a code is at least searchable, where "something went wrong" is not.
const LAUNCH_ERRORS: Record<string, string> = {
  // Client attestation & compliance (api lib/compliance).
  attestation_required: "Tick both boxes to confirm your ad is truthful and that you have the rights to your photos and videos.",
  terms_not_accepted: "Please accept the updated Terms of Service first (reload the page).",
  needs_review: "Some wording in this ad is checked by AdVault before it can run. We usually review within a day.",
  ad_taken_down: "AdVault removed this ad. Email 3pandas@3pandalabs.com if you think this is a mistake.",
  plan_required: "Start your AdVault plan to run your ad.",
  plan_pending: "We're confirming your plan. Try again in a few seconds.",
  not_running: "This ad isn't running, so there's nothing to pause.",
  not_paused: "This ad isn't paused.",
  campaign_ended: "This ad reached its end date. Make a new campaign to run it again.",
  ad_account_unavailable: "We can't reach this ad's Google account right now. Please try again later.",
  plan_has_no_ads: "Your plan makes videos but doesn't run ads. Switch to Managed or Keep it running to launch.",
  google_ads_not_configured:
    "Google Ads launching is not switched on for this account yet. Everything else works — your videos are rendered and ready.",
  ad_account_revoked:
    "Your Google Ads connection expired. Reconnect it in Settings and try again.",
  no_ready_creatives: "Wait for at least one video to finish rendering first.",
  already_launched: "This campaign has already been sent to Google Ads.",
  open_house_over: "The open house date has passed, so this ad has nothing left to promote. Make a new campaign for your next listing or a “Just sold” ad.",
  landing_url_required:
    "Google needs a website link before your ad can go live. Add one under “Your website” below.",
  website_not_published:
    "Your website isn't published yet, so people who tap your ad wouldn't see it. Publish it on SiteVault, then launch.",
  website_paused: "Your website is paused, so people who tap your ad couldn't see it. Renew it on SiteVault, then launch.",
  website_not_found: "We couldn't find your website at that link. Check the link under “Your website” below.",
  no_resolvable_zip_codes: "Google did not recognise any of those ZIP codes.",
  // US housing-ads policy, re-checked at launch (lib/audience/policy.ts).
  housing_demographics_not_allowed:
    "Housing ads in the US can't target by age, gender or family status (Google policy). Remove those filters under “Who should see it”.",
  housing_zip_targeting_not_allowed:
    "Housing ads in the US can't target by ZIP code (Google policy). Create the campaign again as Real estate with the listing address.",
  listing_address_required:
    "Real-estate campaigns need the listing address. Create the campaign again with it.",
  zip_codes_required: "This campaign has no ZIP codes to target.",
  // The wallet guard on accounts AdVault funds. Previously unmapped, so a 402
  // surfaced as the raw code.
  insufficient_funds:
    "Your ad budget is too low to start. Add to your ad budget above and try again.",
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
    "We're finishing your ad account's setup. Launch unlocks automatically. Usually done quickly. We'll email you as soon as your ad account is ready.",
  currency_mismatch:
    "This campaign's budget currency doesn't match the ad account's. Create the campaign again in the account's currency.",
  provisioning_failed: "We couldn't set up your ad account just now. Please try again in a few minutes.",
  // Customer-uploaded videos are reviewed by AdVault before they can run.
  video_pending_review:
    "Your uploaded video is waiting for AdVault's review — usually within a day. Launch unlocks once it's approved.",
  video_rejected:
    "Your uploaded video wasn't approved, so there's nothing to launch. See the reason on the video, then upload a new one or remove it.",
  // Google's Demand Gen per-day minimum ($5 USD); campaigns saved under the
  // old $1 floor hit it. The API's detail (currency-aware) wins when present.
  budget_below_minimum: BUDGET_BELOW_MINIMUM_MESSAGE,
};

// Google reviews every ad again after launch. Raw enums from
// ad_group_ad.policy_summary, mirrored from api/src/lib/adMetrics/adPolicy.ts.
function googleReviewLabel(
  approval: string | null | undefined,
  review: string | null | undefined,
): { text: string; tone: "success" | "pending" | "danger" } | null {
  if (!approval && !review) return null;
  if (approval === "DISAPPROVED") return { text: "Disapproved", tone: "danger" };
  if (review === "REVIEW_IN_PROGRESS" || review === "UNDER_APPEAL") return { text: "Under review", tone: "pending" };
  if (approval === "APPROVED") return { text: "Approved", tone: "success" };
  if (approval === "APPROVED_LIMITED" || approval === "AREA_OF_INTEREST_ONLY")
    return { text: "Approved (limited)", tone: "success" };
  return { text: "Under review", tone: "pending" };
}

export default function CampaignDetailPage({
  params,
}: {
  params: Promise<{ campaignId: string }>;
}) {
  const { campaignId } = use(params);
  const [campaign, setCampaign] = useState<Loaded | null>(null);
  const [adAccountsFailed, setAdAccountsFailed] = useState(false);
  const [adAccounts, setAdAccounts] = useState<{
    configured: boolean;
    managedOffered?: boolean;
    accounts: AdAccount[];
  } | null>(null);
  const [settingUp, setSettingUp] = useState(false);
  // The ad budget (wallet) and its low / ran-out state, for the banner and card.
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  // SiteVault site: the ad video joins the website at launch (box ticked by default).
  const [videoOnSite, setVideoOnSite] = useState(true);
  // Only a site AdVault made takes the ad video (SiteVault refuses one built there).
  const onSite = Boolean(siteVaultSlug(campaign?.landingUrl)) && Boolean(campaign?.sitevaultEditEnc);
  // Seeded when back from a top-up checkout started on this page (?status=success).
  const [launchNote, setLaunchNote] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    const q = new URLSearchParams(window.location.search);
    if (q.get("subscribed") === "1") return "Your AdVault plan is set up. Press Launch my ads (or Resume) to start your ad.";
    return q.get("status") === "success" ? "Thanks — your ad budget top-up went through. It can take a minute to show." : null;
  });
  // The AdVault plan (lib/planBilling): set when launch / resume answered
  // plan_required; shows the start-plan card ($0 today with the first month).
  const [planPrompt, setPlanPrompt] = useState<{ firstMonthIncluded: boolean } | null>(null);
  // "Keep it running" (recommended, preselected) or "Just this once", and the
  // monthly ad budget (the wizard's pick, else $35).
  const [planOption, setPlanOption] = useState<"monthly" | "once">("monthly");
  const [planBudget, setPlanBudget] = useState<number>(() => {
    try {
      const v = Number(typeof window === "undefined" ? 0 : sessionStorage.getItem(wizardTopupKey(campaignId)));
      return Number.isFinite(v) && v >= MONTHLY_AD_BUDGET_CENTS ? v : MONTHLY_AD_BUDGET_CENTS;
    } catch {
      return MONTHLY_AD_BUDGET_CENTS;
    }
  });
  const [firstMonthAvailable, setFirstMonthAvailable] = useState(true);
  const [testMode, setTestMode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [logo, setLogo] = useState<Asset | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  // Internal accounts (our own apps) may upload their own video, like admins;
  // it still waits for admin review and uses the customer limits.
  const [isInternal, setIsInternal] = useState(false);
  // An admin's test customer: launch is always a dry run (api routes/launch.ts).
  const [isTestCustomer, setIsTestCustomer] = useState(false);
  // Two-click remove: the first click arms it, so a stray click can't delete.
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  // Keep it running: the campaign's paid-ad order, if this user pays per ad.
  const [newAd, setNewAd] = useState<NewAdStatus | null>(null);
  const [redoConfirm, setRedoConfirm] = useState(false);
  const generatingRef = useRef(false);
  // Set while the API writes the script (inside the generate/redo request).
  // Kept in sessionStorage so a refresh mid-request still shows it (the
  // server finishes the redo either way; without this the page showed the
  // old video, 0 redos left and no sign anything was happening).
  const [writingSince, setWritingState] = useState<number | null>(() => readWriting(campaignId));
  const setWritingSince = useCallback(
    (t: number | null) => {
      saveWriting(campaignId, t);
      setWritingState(t);
    },
    [campaignId],
  );
  // Hidden as soon as the new version's creatives exist.
  const showWriting =
    writingSince !== null &&
    !(campaign?.creatives ?? []).some((c) => c.kind !== "upload" && Date.parse(c.createdAt) >= writingSince - 5000);
  // Offer combo: "Also put this offer on my website" on a new-ad purchase.
  // Pre-ticked when SiteVault's edit page sent them here (?siteOffer=1).
  const [siteOfferTicked, setSiteOfferTicked] = useState(false);
  const [siteOfferDeepLink, setSiteOfferDeepLink] = useState(false);
  const [siteOfferRev, setSiteOfferRev] = useState(0);
  // The two required ticks (api lib/compliance), one set per action.
  const [orderTicks, setOrderTicks, orderAttestation] = useAttestation();
  const [redoTicks, setRedoTicks, redoAttestation] = useAttestation();
  const [launchTicks, setLaunchTicks, launchAttestation] = useAttestation();
  const orderSiteOffer = Boolean(siteOfferTicked && newAd?.siteOffer);
  const orderFailed = (err: unknown, fallback: string) => {
    if (err instanceof ApiError && err.code === "site_offer_unavailable") {
      setError("We couldn't reach your website just now. Untick “Also put this offer on my website” or try again in a minute.");
      getNewAdStatus(campaignId).then(setNewAd).catch(() => undefined);
    } else setError(fallback);
  };

  const refresh = useCallback(
    () => getCampaign(campaignId).then(setCampaign).catch(() => setError("Could not load this campaign.")),
    [campaignId],
  );

  useEffect(() => {
    refresh();
    listAdAccounts().then(setAdAccounts).catch(() => setAdAccountsFailed(true));
    getWallet().then(setWallet).catch(() => undefined);
    getMe()
      .then((me) => {
        setIsAdmin(actsAsAdmin(me));
        setIsInternal(me?.isInternal === true);
        setIsTestCustomer(me.isTestCustomer === true);
        setTestMode(me.isTestCustomer === true || (me.role === "admin" && me.testAsCustomer === true));
      })
      .catch(() => undefined);
    getSubscription()
      .then((s) => setFirstMonthAvailable(s.plan?.firstMonthAvailable !== false))
      .catch(() => undefined);
    getNewAdStatus(campaignId)
      .then((s) => {
        setNewAd(s);
        if (new URLSearchParams(window.location.search).get("siteOffer") === "1") {
          setSiteOfferTicked(true);
          setSiteOfferDeepLink(true);
        }
      })
      .catch(() => undefined);
  }, [refresh, campaignId]);

  // After checkout the payment webhook marks the order paid; until then, poll.
  // Once paid, make the ad from the photos and formats saved on the order.
  const orderStatus = newAd?.order?.status;
  useEffect(() => {
    if (!newAd?.order) return;
    if (orderStatus === "pending") {
      const timer = setInterval(() => {
        getNewAdStatus(campaignId).then(setNewAd).catch(() => undefined);
      }, 4000);
      return () => clearInterval(timer);
    }
    if (orderStatus === "paid" && !generatingRef.current) {
      generatingRef.current = true;
      setWritingSince(nowMs());
      generatePaidNewAd(newAd.order.id)
        .then(() => Promise.all([refresh(), getNewAdStatus(campaignId).then(setNewAd)]))
        .catch(() => setError("Your payment went through, but making the ad failed. Reload the page to try again."))
        .finally(() => {
          generatingRef.current = false;
          setWritingSince(null);
        });
    }
  }, [newAd, orderStatus, campaignId, refresh, setWritingSince]);

  // Poll while anything is still encoding. The API returns 202 from the
  // generate call and the renderer works through a queue on a separate
  // container, so there is nothing to await — this is the progress indicator.
  // The interval clears itself as soon as nothing is pending, so a finished
  // campaign page makes no background requests at all.
  // Publishing to YouTube counts as pending too. Without it the page stopped
  // polling the moment the encode finished and then sat there showing
  // "Publishing…" forever, with the Launch button withheld and no explanation.
  // An upload waiting for AdVault's review is not publishing — it waits on a
  // person, possibly for hours — so it is polled once a minute, not every 5s.
  // A rejected one is not waiting on anything.
  const awaitingReview = campaign?.creatives.some((c) => c.reviewStatus === "pending_review") ?? false;
  const pending = showWriting || campaign?.creatives.some(
    (c) =>
      c.renderStatus === "queued" ||
      c.renderStatus === "rendering" ||
      (c.renderStatus === "ready" &&
        !c.youtubeVideoId &&
        c.youtubeUploadStatus !== "failed" &&
        (c.reviewStatus === null || c.reviewStatus === "approved")),
  );
  useEffect(() => {
    if (!pending && !awaitingReview) return;
    const timer = setInterval(refresh, pending ? 5000 : 60_000);
    return () => clearInterval(timer);
  }, [pending, awaitingReview, refresh]);

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

  async function onLaunch(adAccountId: string, dryRun = false) {
    if (!launchAttestation) return setError(LAUNCH_ERRORS.attestation_required!);
    setBusy(true);
    setError(null);
    setLaunchNote(null);
    try {
      const result = await launchCampaign(campaignId, adAccountId, launchAttestation, onSite ? videoOnSite : undefined, dryRun || undefined);
      const lead = result.validateOnly
        ? "Dry run passed. Google checked everything. Nothing went live and $0 was spent."
        : result.note;
      setLaunchNote(
        result.radiusMilesAroundAddress !== null
          ? `${lead} Targeted ${result.radiusMilesAroundAddress} miles around your listing.`
          : `${lead} Targeted ${result.zipCodesTargeted} of ${result.zipCodesRequested} ZIP codes.`,
      );
      await refresh();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "request_failed";
      if (code === "plan_required" && err instanceof ApiError) {
        setPlanPrompt({ firstMonthIncluded: err.body?.firstMonthIncluded === true });
        return;
      }
      // Google's own reason is more useful than the bare code, which is all
      // that showed before: "Launch failed (google_ads_error)".
      const detail = err instanceof ApiError ? err.detail : undefined;
      setError(
        (code === "budget_below_minimum" && detail) ||
          LAUNCH_ERRORS[code] ||
          (code === "google_ads_error" && detail
            ? `Google Ads rejected the campaign: ${detail}`
            : `Launch failed (${code}).`),
      );
    } finally {
      setBusy(false);
    }
  }

  async function onStartPlan() {
    setBusy(true);
    setError(null);
    try {
      if (planOption === "once") {
        // "Just this once": no subscription; the ad runs on its budget.
        await setPlanChoice("once");
        setPlanPrompt(null);
        setLaunchNote("Just this once: no plan and no renewals. Press Launch my ads (or Resume) again.");
        return;
      }
      const r = await subscribe("us-evergreen", campaignId, planBudget);
      if (r.redirectUrl) {
        window.location.assign(r.redirectUrl);
        return;
      }
      setPlanPrompt(null);
      setLaunchNote("Your plan is set up. Press Launch my ads (or Resume) again.");
    } catch {
      setError("Could not start your plan. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  // "Pause anytime: no fee while paused." (lib/planBilling)
  async function onPauseResume(action: "pause" | "resume") {
    setBusy(true);
    setError(null);
    setLaunchNote(null);
    try {
      if (action === "pause") {
        await pauseCampaign(campaignId);
        setLaunchNote(
          "Paused. Your ad has stopped showing. With no ad running, your $20 plan stops at the end of the month you've paid for: no fee and no ad-budget recharge while paused.",
        );
      } else {
        const r = await resumeCampaign(campaignId);
        setPlanPrompt(null);
        setLaunchNote(
          r.planRestarted
            ? "Your ad is running again. Your $20 plan restarted today with your saved card."
            : "Your ad is running again.",
        );
      }
      await Promise.all([refresh(), getWallet().then(setWallet)]);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "request_failed";
      if (code === "plan_required" && err instanceof ApiError) {
        setPlanPrompt({ firstMonthIncluded: err.body?.firstMonthIncluded === true });
      } else {
        const detail = err instanceof ApiError ? err.detail : undefined;
        setError(LAUNCH_ERRORS[code] ?? detail ?? `Couldn't ${action} the ad (${code}).`);
      }
    } finally {
      setBusy(false);
    }
  }

  // Deep links from the dashboard's Manage menu (#audience, #ad-budget): the
  // page renders "Loading…" first, so the browser's own jump to the hash
  // misses. Once the campaign is here, wait for the card (it can depend on
  // the wallet / ad accounts loading too) and scroll to it, once.
  const loaded = campaign !== null;
  useEffect(() => {
    if (!loaded) return;
    const id = window.location.hash.slice(1);
    if (!id) return;
    let tries = 0;
    const timer = window.setInterval(() => {
      const el = document.getElementById(id);
      if (el || ++tries > 20) {
        window.clearInterval(timer);
        el?.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    }, 100);
    return () => window.clearInterval(timer);
  }, [loaded]);

  if (error && !campaign) return <p className="text-sm text-red-300">{error}</p>;
  if (!campaign) return <p className="text-sm text-zinc-500">Loading…</p>;

  // "Launchable" means rendered AND published to YouTube. Filtering on
  // renderStatus alone offered a Launch button for a campaign that would be
  // created at Google with no ad attached to it.
  const ready = campaign.creatives.filter(
    (c) => c.renderStatus === "ready" && c.youtubeVideoId,
  );
  const renderedNotPublished = campaign.creatives.filter(
    (c) =>
      c.renderStatus === "ready" &&
      !c.youtubeVideoId &&
      (c.reviewStatus === null || c.reviewStatus === "approved"),
  );
  // Uploads held for AdVault's review; launch refuses while any is pending.
  const inReview = campaign.creatives.filter((c) => c.reviewStatus === "pending_review");
  const googleReview = googleReviewLabel(campaign.googleAdApprovalStatus, campaign.googleAdReviewStatus);
  const activeAccounts = adAccounts?.accounts.filter((a) => a.status === "active") ?? [];
  // Accounts a campaign can go into right now. One still waiting for its card
  // gets the "being set up" message instead of a button that would 409.
  // A test customer only ever does a dry run, which Google allows before the
  // card is added, so any account Google already knows (has an id) will do.
  const launchableAccounts = activeAccounts.filter((a) =>
    isTestCustomer ? Boolean(a.customerId) : !isAwaitingPlatformSetup(a),
  );
  const launchedAccount = adAccounts?.accounts.find((a) => a.id === campaign.adAccountId);
  const launchedForCustomer = launchedAccount?.billingMode === "platform";
  // Does the AdVault ad budget (wallet) pay for this campaign? Platform
  // billing only; before an account exists, the managed path is the default.
  const usesWallet = launchedAccount
    ? launchedAccount.billingMode === "platform"
    : activeAccounts.length > 0
      ? activeAccounts.some((a) => a.billingMode === "platform")
      : Boolean(adAccounts?.managedOffered);

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{campaign.name}</h1>
          <p className="mt-1 text-sm text-zinc-400">
            {campaign.runDays ? <>{runLengthLabel(campaign.runDays, campaign.endsOn)} &middot;{" "}</> : null}
            {campaign.targetAddress
              ? `${campaign.radiusMiles} miles around ${campaign.targetAddress.street}, ${campaign.targetAddress.city}`
              : `${campaign.targetZipCodes.join(", ")} within ${campaign.radiusMiles} miles`}
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
      {usesWallet && <BudgetBanner wallet={wallet} campaignId={campaign.id} href="#ad-budget" />}

      {/* Before launch only: fix the category or area, or delete the draft. */}
      {!campaign.googleCampaignResourceName && campaign.complianceStatus !== "taken_down" && (
        <DetailsCard
          campaign={campaign}
          locked={Boolean(newAd?.order) || campaign.creatives.some((c) => c.kind !== "upload")}
          onSaved={(c) => setCampaign((prev) => (prev ? { ...prev, ...c } : prev))}
        />
      )}

      {/* Client attestation & compliance (api lib/compliance). */}
      {campaign.complianceStatus === "taken_down" && (
        <div className="mb-4 rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2 text-sm text-red-200">
          <p className="font-medium">AdVault removed this ad.</p>
          <p className="mt-1">
            It has been stopped and can&apos;t be launched, resumed or made again.
            {campaign.takenDownReason ? ` Reason: ${campaign.takenDownReason}` : ""} Email{" "}
            <a href="mailto:3pandas@3pandalabs.com" className="underline">
              3pandas@3pandalabs.com
            </a>{" "}
            if you think this is a mistake.
          </p>
        </div>
      )}
      {campaign.complianceStatus === "needs_review" && (
        <div className="mb-4 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-sm text-amber-100">
          <p className="font-medium">AdVault checks some of this ad&apos;s wording before it can run</p>
          <p className="mt-1">
            You can still make your ad. Launch unlocks once an AdVault admin has looked at it, usually within a
            day. Or change the wording and save it.
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {(campaign.complianceReasons ?? [])
              .filter((r) => !r.approved)
              .map((r) => (
                <li key={`${r.id}:${r.phrase}:${r.field}`}>
                  &ldquo;{r.phrase}&rdquo; ({fieldLabel(r.field)}): {r.reason}
                </li>
              ))}
          </ul>
        </div>
      )}

      {launchNote && (
        <p className="mb-4 rounded-lg border border-emerald-400/30 bg-emerald-400/10 px-3 py-2 text-sm text-emerald-200">
          {launchNote}
        </p>
      )}

      {showWriting && writingSince !== null && (
        <Card className="mb-4">
          <CardTitle>Making your new ad</CardTitle>
          <div className="mt-3">
            <ScriptProgress startedAt={writingSince} />
          </div>
        </Card>
      )}

      {newAd?.required && campaign.creatives.length === 0 && (
        <Card className="mb-4">
          {orderStatus === "pending" ? (
            <CardDescription>Waiting for your {newAd.display} payment to confirm…</CardDescription>
          ) : orderStatus === "paid" || orderStatus === "producing" ? (
            <CardDescription>Payment received. Making your ad…</CardDescription>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <CardDescription>
                {newAd.freeLaunchOffer
                  ? "This campaign has no ad yet. Your first ad is free (launch offer)."
                  : `This campaign has no ad yet. Making it costs ${newAd.display}, including up to two redos.`}
              </CardDescription>
              {newAd.order && (
                <AttestationChecks className="w-full" value={orderTicks} onChange={setOrderTicks} disabled={busy} />
              )}
              {newAd.order && (
                <Button
                  size="sm"
                  disabled={busy || !orderAttestation}
                  onClick={() => {
                    if (!orderAttestation) return;
                    setBusy(true);
                    setError(null);
                    orderNewAd(campaign.id, { ...(orderSiteOffer ? { siteOffer: true } : {}), attestation: orderAttestation })
                      .then(({ checkout }) => {
                        if (checkout.redirectUrl) window.location.href = checkout.redirectUrl;
                        else {
                          setSiteOfferRev((n) => n + 1);
                          return getNewAdStatus(campaignId).then(setNewAd);
                        }
                      })
                      .catch((err) => orderFailed(err, "Could not start the payment. Please try again."))
                      .finally(() => setBusy(false));
                  }}
                >
                  {newAd.freeLaunchOffer ? "Make my free ad" : `Pay ${payLabel(newAd, orderSiteOffer)} and make my ad`}
                </Button>
              )}
              {newAd.order && (
                <div className="w-full">
                  <SiteOfferOption status={newAd} checked={siteOfferTicked} onChange={setSiteOfferTicked} disabled={busy} />
                </div>
              )}
              {newAd.order && !newAd.freeLaunchOffer && (
                <PlanPriceLines
                  className="w-full"
                  testMode={testMode}
                  firstMonthIncluded={firstMonthAvailable}
                  addMoreHref={usesWallet ? "#ad-budget" : undefined}
                />
              )}
            </div>
          )}
        </Card>
      )}

      {(() => {
        // "Make it again": only for an AdVault-made ad that is finished, not live.
        const made = campaign.creatives.filter((c) => c.kind !== "upload");
        const busyRendering = made.some((c) => c.renderStatus === "queued" || c.renderStatus === "rendering");
        if (campaign.status === "live" || made.length === 0 || busyRendering || !newAd || showWriting) return null;
        const left = newAd.redosLeft;
        const metered = newAd.required;
        const canRedo = !metered || (left ?? 0) > 0;
        return (
          <Card className="mb-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <CardTitle>Not quite right?</CardTitle>
                <CardDescription>
                  {canRedo
                    ? `We write a new script and make a new version from the same photos. It replaces the current one.${metered ? ` ${left} free ${left === 1 ? "redo" : "redos"} left on this ad.` : ""}`
                    : `You've used this ad's free redos. A new version is ${newAd.display}, including two more redos.`}
                </CardDescription>
              </div>
              {redoConfirm ? (
                <div className="flex items-center gap-2">
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => setRedoConfirm(false)}>
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    disabled={busy || !redoAttestation}
                    onClick={() => {
                      if (!redoAttestation) return;
                      setBusy(true);
                      setError(null);
                      if (canRedo) setWritingSince(nowMs());
                      const go = canRedo
                        ? redoAd(campaign.id, redoAttestation).then(() => Promise.all([refresh(), getNewAdStatus(campaignId).then(setNewAd)]))
                        : orderNewAd(campaign.id, { ...(orderSiteOffer ? { siteOffer: true } : {}), attestation: redoAttestation }).then(({ checkout }) => {
                            if (checkout.redirectUrl) window.location.href = checkout.redirectUrl;
                          });
                      go.catch((err) => orderFailed(err, "Could not start a new version. Please try again."))
                        .finally(() => {
                          setBusy(false);
                          setRedoConfirm(false);
                          setWritingSince(null);
                        });
                    }}
                  >
                    {canRedo ? "Yes, replace it" : `Pay ${payLabel(newAd, orderSiteOffer)}`}
                  </Button>
                </div>
              ) : (
                <Button variant="outline" size="sm" onClick={() => setRedoConfirm(true)}>
                  {canRedo ? `Make it again${metered ? ` (${left} left)` : ""}` : `New version for ${newAd.display}`}
                </Button>
              )}
            </div>
            {redoConfirm && <AttestationChecks className="mt-3" value={redoTicks} onChange={setRedoTicks} disabled={busy} />}
            {metered && !canRedo && (
              <SiteOfferOption status={newAd} checked={siteOfferTicked} onChange={setSiteOfferTicked} disabled={busy} />
            )}
            {metered && canRedo && siteOfferDeepLink && newAd.siteOffer && (
              <p className="mt-3 text-sm text-zinc-400">
                To put this offer on your website with a new ad, use this ad&rsquo;s free redos first; the option appears when you buy a new version.
              </p>
            )}
          </Card>
        );
      })()}

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
                    ? creative.renderInfo?.engine === "reformat"
                      ? "Made from your video, so your ad also fits this shape"
                      : "Uploaded video"
                    : (creative.script?.hook ?? "Writing the script…")}
                  {creative.kind !== "upload" &&
                    ` · Version ${creative.version ?? 1}${(creative.version ?? 1) > 1 ? ` (redo ${(creative.version ?? 1) - 1})` : " (first)"}`}
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
                  creative.reviewStatus === "rejected" ||
                  creative.renderStatus === "failed" ||
                  creative.youtubeUploadStatus === "failed"
                    ? "danger"
                    : creative.renderStatus === "ready" && creative.youtubeVideoId
                      ? "success"
                      : "pending"
                }
              >
                {creative.reviewStatus === "pending_review"
                  ? "Pending review"
                  : creative.reviewStatus === "rejected"
                    ? "Rejected"
                    : creative.renderStatus === "queued"
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

            {(creative.renderStatus === "queued" || creative.renderStatus === "rendering") && creative.kind !== "upload" && (
              <RenderProgress
                createdAt={creative.createdAt}
                queued={creative.renderStatus === "queued"}
                // The renderer makes one shape at a time: the later of a pair
                // waits for the first, so it is expected to take longer.
                expectedSeconds={
                  campaign.creatives.some(
                    (o) =>
                      o.id !== creative.id &&
                      (o.renderStatus === "queued" || o.renderStatus === "rendering") &&
                      Date.parse(o.createdAt) < Date.parse(creative.createdAt),
                  )
                    ? 390
                    : 300
                }
              />
            )}

            {creative.renderStatus === "ready" && previews[creative.id] && (
              <video
                controls
                src={previews[creative.id]}
                className={`mt-4 rounded-lg border border-white/10 ${
                  creative.aspectRatio === "9:16" ? "max-h-96" : "w-full"
                }`}
              />
            )}

            {creative.kind === "upload" && <UploadReviewNote creative={creative} all={campaign.creatives} />}

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
            {/* Waiting on YouTube's daily upload cap: retried automatically. */}
            {creative.renderStatus === "ready" &&
              creative.youtubeUploadStatus === "pending" &&
              creative.youtubeUploadError && (
                <p className="mt-4 text-sm text-amber-300">{creative.youtubeUploadError}</p>
              )}

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

            {creative.kind === "upload" &&
              !creative.googleAdResourceName &&
              !campaign.googleCampaignResourceName &&
              creative.youtubeUploadStatus !== "uploading" && (
                <div className="mt-3 flex items-center gap-3">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      if (confirmRemove !== creative.id) return setConfirmRemove(creative.id);
                      setConfirmRemove(null);
                      removeUploadedCreative(creative.id)
                        .then(refresh)
                        .catch(() => setError("Could not remove this video."));
                    }}
                  >
                    {confirmRemove === creative.id ? "Click again to remove" : "Remove video"}
                  </Button>
                  {confirmRemove === creative.id && (
                    <button type="button" className="text-xs text-zinc-500 hover:text-zinc-300" onClick={() => setConfirmRemove(null)}>
                      Cancel
                    </button>
                  )}
                </div>
              )}
          </Card>
        ))}
      </div>

      {/* "Use my own video" is the other way to get an ad: once they chose photos
          (an order or an AdVault-made video exists) it is only noise. */}
      {/* Also hidden once a video is uploaded: one is enough (AdVault makes the
          other shape; admins/internal may add their own, below). To replace
          it, remove it first. */}
      {/* Both shapes up front (admins and internal accounts, 2026-11-20): one
          upload slot per shape the owner hasn't uploaded THEMSELVES (AdVault's
          "Made from your video" copies don't count; an own upload replaces
          the copy in that shape). Hidden once launched, once a paid ad order
          exists, or once AdVault made a video. Remove one to replace it. */}
      {(() => {
        if (!(isAdmin || isInternal) || campaign.googleCampaignResourceName || newAd?.order) return null;
        if (campaign.creatives.some((c) => c.kind !== "upload")) return null;
        const own = new Set(
          campaign.creatives.filter((c) => c.renderInfo?.engine !== "reformat").map((c) => c.aspectRatio),
        );
        const missing = (["9:16", "16:9"] as const).filter((a) => !own.has(a));
        if (missing.length === 0) return null;
        return (
          <div className="mb-4 grid gap-4 md:grid-cols-2">
            {missing.map((aspect) => (
              <VideoUpload
                key={aspect}
                campaignId={campaignId}
                isAdmin={isAdmin}
                onUploaded={refresh}
                onlyAspect={aspect}
                optional={aspect === "16:9" || own.size > 0}
              />
            ))}
          </div>
        );
      })()}

      {newAd && !newAd.required && newAd.siteOffer && (
        <Card className="mb-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <CardTitle>Update the offer on your website</CardTitle>
              <CardDescription className="break-words">
                Your website shows a different offer. Change it to this ad&apos;s: “{newAd.siteOffer.offer}”
              </CardDescription>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setError(null);
                pushFreeSiteOffer(campaign.id)
                  .then(() => setSiteOfferRev((n) => n + 1))
                  .catch((err) => orderFailed(err, "Could not update your website. Please try again."))
                  .finally(() => setBusy(false));
              }}
            >
              Update my website
            </Button>
          </div>
        </Card>
      )}

      {/* "Change my offer" (api lib/offerSwap): launched campaigns only. */}
      {campaign.googleCampaignResourceName && (campaign.status === "live" || campaign.status === "paused") ? (
        <ChangeOfferCard campaign={campaign} />
      ) : (
        // Not launched yet: the optional WhatsApp number (the Change my offer
        // card carries it once the ad runs). Never blocks anything.
        <WhatsAppPrompt className="mb-4" />
      )}

      {/* Seasonal calendar (lib/categories/seasons): only when a season is near. */}
      <SeasonCard
        campaign={campaign}
        onSaved={(c) => setCampaign((prev) => (prev ? { ...prev, ...c } : prev))}
      />

      <WebsiteCard
        campaign={campaign}
        ownVideoOnly={campaign.creatives.length > 0 && campaign.creatives.every((c) => c.kind === "upload")}
        onSaved={(c) => setCampaign((prev) => (prev ? { ...prev, ...c } : prev))}
        siteOfferRev={siteOfferRev}
      />

      {/* The wizard's filters are parked for MVP2; the card still shows for a
          campaign that has filters, and for any launched campaign, whose
          audience can now be changed at Google (PUT /campaigns/:id/targeting). */}
      {(AUDIENCE_FILTERS_ENABLED || campaign.audienceFilters || campaign.googleCampaignResourceName) && (
        <AudienceCard
          campaign={campaign}
          onSaved={(c) => setCampaign((prev) => (prev ? { ...prev, ...c } : prev))}
        />
      )}

      <ScheduleCard
        campaign={campaign}
        onSaved={(c) => setCampaign((prev) => (prev ? { ...prev, ...c } : prev))}
      />

      {usesWallet && <AdBudgetCard campaign={campaign} wallet={wallet} />}

      {planPrompt && (
        <Card id="plan-choice" className="mt-2 mb-4 scroll-mt-6 border-amber-400/30">
          <CardTitle>How should your ad run?</CardTitle>
          <div className="mt-3 space-y-2" role="radiogroup" aria-label="How should your ad run?">
            <label
              className={`block cursor-pointer rounded-lg border p-3 ${planOption === "monthly" ? "border-amber-400 bg-amber-400/10" : "border-white/15"}`}
            >
              <span className="flex items-center gap-2">
                <input
                  type="radio"
                  name="plan-option"
                  className="accent-amber-400"
                  checked={planOption === "monthly"}
                  onChange={() => setPlanOption("monthly")}
                />
                <span className="font-medium">Keep it running</span>
                <Badge>Recommended</Badge>
              </span>
              <span className="mt-1 block text-sm text-zinc-300">
                {planPrompt.firstMonthIncluded
                  ? "Plan $0 today: your first month is included."
                  : `Charged today: ${formatMoney(monthlyTotalCents(planBudget), "USD")} ($20 plan + your monthly ad budget).`}{" "}
                Then $20 a month plus your monthly ad budget, recharged automatically, only while your ad runs.
              </span>
              <span className="mt-1 block text-sm text-amber-200">
                Renews at {formatMoney(monthlyTotalCents(planBudget), "USD")}/month from{" "}
                {formatDate(oneMonthFromToday().toISOString())}. Cancel anytime in one click.
              </span>
            </label>
            <label
              className={`block cursor-pointer rounded-lg border p-3 ${planOption === "once" ? "border-amber-400 bg-amber-400/10" : "border-white/15"}`}
            >
              <span className="flex items-center gap-2">
                <input
                  type="radio"
                  name="plan-option"
                  className="accent-amber-400"
                  checked={planOption === "once"}
                  onChange={() => setPlanOption("once")}
                />
                <span className="font-medium">Just this once</span>
              </span>
              <span className="mt-1 block text-sm text-zinc-300">
                One payment. No renewals. Your ad stops when the budget runs out.
              </span>
            </label>
          </div>
          {planOption === "monthly" && (
            <div className="mt-3">
              <p className="mb-1 text-sm font-medium text-zinc-200">Your monthly ad budget</p>
              <TopUpPicker mode="choose" currency="USD" value={planBudget} onChange={setPlanBudget} showEstimate={false} />
            </div>
          )}
          {planOption === "monthly" && (
            <PlanPriceLines
              className="mt-3"
              testMode={testMode}
              firstMonthIncluded={planPrompt.firstMonthIncluded}
              budgetCents={planBudget}
              addMoreHref={usesWallet ? "#ad-budget" : undefined}
            />
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            <Button disabled={busy} onClick={onStartPlan}>
              {busy
                ? planOption === "once"
                  ? "Saving…"
                  : "Opening checkout…"
                : planOption === "once"
                  ? "Continue, just this once"
                  : planPrompt.firstMonthIncluded
                    ? "Start my plan ($0 today)"
                    : "Restart my plan"}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setPlanPrompt(null)}>
              Not now
            </Button>
          </div>
          <p className="mt-2 text-xs text-zinc-500">
            {planOption === "once"
              ? "Your ad budget is a one-time top-up on this page. You can turn on Keep it running later from Subscription; it then starts charging that day."
              : planPrompt.firstMonthIncluded
                ? "Stripe saves your card. Nothing more is charged until your included month ends, and only if an ad is still running then."
                : "Come back here after paying and press the button again."}
          </p>
        </Card>
      )}

      <Card className="mt-2 mb-4">
        <CardTitle>Launch</CardTitle>
        {campaign.googleCampaignResourceName ? (
          <>
            <CardDescription>
              {launchedForCustomer
                ? "Your campaign is live. Google reviews new ads first, usually within a day, then they start showing in your area."
                : "Sent to Google Ads. Open your Google Ads account to review it and switch it on — it was created paused and is not spending yet."}
            </CardDescription>
            {campaign.runDays ? (
              <p className="mt-2 text-sm text-zinc-400">
                {runLengthLabel(campaign.runDays, campaign.endsOn)}. Google stops it by itself on the last day.
              </p>
            ) : null}
            {/* "Pause anytime: no fee while paused." Managed (platform) accounts only. */}
            {launchedForCustomer && campaign.complianceStatus !== "taken_down" && (campaign.status === "live" || campaign.status === "paused") && (
              <div className="mt-3 flex flex-wrap items-center gap-3">
                {campaign.status === "live" ? (
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => onPauseResume("pause")}>
                    {busy ? "Pausing…" : "Pause my ad"}
                  </Button>
                ) : (
                  <Button size="sm" disabled={busy} onClick={() => onPauseResume("resume")}>
                    {busy ? "Starting…" : "Resume my ad"}
                  </Button>
                )}
                <span className="text-xs text-zinc-500">
                  {campaign.status === "live"
                    ? "Pause anytime: no fee and no recharge while paused."
                    : "Paused: no plan fee and no ad-budget recharge for months with no ad running."}
                </span>
              </div>
            )}
            {/* Google's own ad review, synced hourly. */}
            {googleReview && (
              <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-zinc-400">
                <Badge tone={googleReview.tone}>Google: {googleReview.text}</Badge>
                {googleReview.tone === "danger" && (campaign.googleAdPolicyTopics?.length ?? 0) > 0 && (
                  <span>
                    {campaign.googleAdPolicyTopics!.map((t) => t.toLowerCase().replace(/_/g, " ")).join(", ")}
                  </span>
                )}
              </div>
            )}
          </>
        ) : !adAccounts ? (
          // Not loaded is not "no account": never offer to connect one on a failed call.
          <CardDescription>
            {adAccountsFailed
              ? "We couldn't load your ad account. Reload the page, or sign in again."
              : "Loading your ad account…"}
          </CardDescription>
        ) : !adAccounts.configured ? (
          <CardDescription>{LAUNCH_ERRORS.google_ads_not_configured}</CardDescription>
        ) : activeAccounts.length === 0 ? (
          adAccounts.managedOffered ? (
            // The default path: the customer never needs a Google or YouTube
            // account. AdVault creates the ad account and pays Google for it.
            <>
              <CardDescription>
                AdVault runs your ads for you — no Google or YouTube account needed. We set up
                your ad account once. Usually done quickly. We&apos;ll email you as soon as your ad account is ready.
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
            automatically. Usually done quickly. We&apos;ll email you as soon as your ad account is ready.
          </CardDescription>
        ) : inReview.length > 0 ? (
          <CardDescription>{LAUNCH_ERRORS.video_pending_review}</CardDescription>
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
            {isTestCustomer && (
              <p className="mb-2 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-sm text-amber-200">
                Test customer: this is a dry run. Google checks everything, nothing goes live, and $0
                is spent.
              </p>
            )}
            <CardDescription>
              {isTestCustomer
                ? "Press the button to have Google check this ad and its settings."
                : launchableAccounts.some((a) => a.billingMode === "platform")
                ? "Launching starts your ad, paid from your ad budget. Google reviews new ads first, usually within a day."
                : "This creates a paused campaign in your Google Ads account. It does not start spending until you enable it there."}
            </CardDescription>
            {/* Only for campaigns saved under the old $1/day floor: everything else
                runs at Google's minimum and the ad budget is shown as times shown. */}
            {campaign.dailyBudgetCents < minDailyBudgetCents(campaign.currencyCode) && (
              <BudgetEditor
                campaign={campaign}
                onSaved={(c) => setCampaign((prev) => (prev ? { ...prev, ...c } : prev))}
              />
            )}
            <SquareLogo onChange={setLogo} />
            {onSite && (
              <label className="mt-4 flex items-start gap-2 text-sm text-zinc-300">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 accent-amber-400"
                  checked={videoOnSite}
                  onChange={(e) => setVideoOnSite(e.target.checked)}
                />
                <span>Also show this ad on my website</span>
              </label>
            )}
            {!onSite && campaign.landingUrl && (
              <p className="mt-4 text-sm text-zinc-400">
                Your ad links to your website, but we can’t add the video to it. We can only put the ad on websites made with AdVault.
              </p>
            )}
            <AttestationChecks className="mt-4" value={launchTicks} onChange={setLaunchTicks} disabled={busy} />
            <div className="mt-4 flex flex-wrap gap-2">
              {launchableAccounts.map((account) => (
                <Button
                  key={account.id}
                  disabled={
                    busy ||
                    !logo ||
                    !launchAttestation ||
                    campaign.complianceStatus === "needs_review" ||
                    campaign.complianceStatus === "taken_down"
                  }
                  onClick={() => onLaunch(account.id)}
                >
                  {busy
                    ? isTestCustomer
                      ? "Checking…"
                      : "Launching…"
                    : isTestCustomer
                      ? "Do a dry run"
                      : account.billingMode === "platform"
                      ? "Launch my ads"
                      : `Launch to ${account.descriptiveName ?? account.customerId}`}
                </Button>
              ))}
              {/* Ours only: Google checks the setup, creates nothing. A real customer has no use for it. */}
              {(isAdmin || isInternal) &&
                !isTestCustomer &&
                launchableAccounts.map((account) => (
                  <Button
                    key={`dry-${account.id}`}
                    variant="outline"
                    disabled={busy || !logo || !launchAttestation || campaign.complianceStatus === "taken_down"}
                    onClick={() => onLaunch(account.id, true)}
                  >
                    Dry run (nothing goes live)
                  </Button>
                ))}
            </div>
            {/* Feedback right under the button: the page-top banners are
                off-screen from here, so a click looked like it did nothing. */}
            {!logo && (
              <p className="mt-2 text-xs text-zinc-400">Add a square logo above to {isTestCustomer ? "do a dry run" : "launch"}.</p>
            )}
            {error && (
              <p className="mt-3 rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2 text-sm text-red-200">{error}</p>
            )}
            {launchNote && (
              <p className="mt-3 rounded-lg border border-emerald-400/30 bg-emerald-400/10 px-3 py-2 text-sm text-emerald-200">
                {launchNote}
              </p>
            )}
            {planPrompt && (
              <p className="mt-3 text-sm text-amber-200">
                <a href="#plan-choice" className="underline underline-offset-2">Choose how your ad runs</a> first, then press the button again.
              </p>
            )}
          </>
        )}
      </Card>

      {/* Only once Google has the campaign — before launch there is nothing
          to report, and an all-zero card would read as "your ad isn't working". */}
      {campaign.googleCampaignResourceName && (
        <ResultsCard
          campaignId={campaignId}
          onTargetingChanged={(c) => setCampaign((prev) => (prev ? { ...prev, ...c } : prev))}
        />
      )}

      {/* The inputs that shape an ad: the wizard asks them before the first ad,
          so here they are for the NEXT one, out of the way. Open when there is
          no ad yet (none made, or every render failed). SeasonCard stays up top. */}
      <details
        open={!campaign.creatives.some((c) => c.renderStatus !== "failed")}
        className="group mt-6 rounded-2xl border border-white/10 bg-white/[0.03]"
      >
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-4 [&::-webkit-details-marker]:hidden">
          <span>
            <span className="block text-sm font-medium text-zinc-200">For your next ad: offer, badges, photos</span>
            <span className="block text-xs text-zinc-400">Changes here are used the next time we make your ad.</span>
          </span>
          <span aria-hidden className="text-zinc-400 transition group-open:rotate-180">
            ▾
          </span>
        </summary>
        <div className="border-t border-white/10 px-3 pt-4 pb-1 sm:px-4">
          <OfferCard
            campaign={campaign}
            onSaved={(c) => setCampaign((prev) => (prev ? { ...prev, ...c } : prev))}
          />

          {/* Per-category trust badges (lib/categories/badges); hidden when none apply. */}
          <BadgesCard campaign={campaign} />

          {/* Category extras (lib/categories/extras): dish, makes, neighbor ZIPs; open-house note. */}
          <ExtrasCard
            campaign={campaign}
            onSaved={(c) => setCampaign((prev) => (prev ? { ...prev, ...c } : prev))}
          />

          {/* Trades only (lib/beforeAfter); renders nothing for other categories. */}
          <BeforeAfterCard campaign={campaign} />
        </div>
      </details>
    </div>
  );
}

/** Where a flagged phrase was found, in words (api lib/compliance complianceTexts). */
function fieldLabel(field: string): string {
  const labels: Record<string, string> = {
    offer: "your offer",
    businessName: "business name",
    name: "campaign name",
    callToAction: "call to action",
    "script.hook": "the ad's opening line",
    "script.body": "the ad's captions",
    "script.voiceover": "the voiceover",
    "script.endCard": "the end card",
    "script.sticker": "the offer sticker",
  };
  return labels[field] ?? field;
}

/**
 * The AdVault review state under an uploaded video. A "Made from your video"
 * copy shows its source's state (it was approved with it).
 */
function UploadReviewNote({ creative, all }: { creative: Creative; all: Creative[] }) {
  const from = creative.renderInfo?.engine === "reformat" ? creative.renderInfo.from : undefined;
  const source = (from && all.find((c) => c.id === from)) || creative;
  const status = source.reviewStatus;
  if (status === "approved") {
    return (
      <p className="mt-3 text-sm text-emerald-300">
        Approved by AdVault admins — you can go ahead.
        {!creative.youtubeVideoId && " We're publishing it to YouTube now."}
      </p>
    );
  }
  if (status === "pending_review") {
    return (
      <p className="mt-3 text-sm text-amber-200">
        Waiting for review by AdVault admins. We&apos;ll approve it before it can run.
      </p>
    );
  }
  if (status === "rejected") {
    return (
      <p className="mt-3 text-sm text-red-300">
        Not approved by AdVault admins{source.reviewReason ? `: ${source.reviewReason}` : "."} Please remove it and
        upload a new video.
      </p>
    );
  }
  return null;
}

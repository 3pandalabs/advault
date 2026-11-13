import { and, desc, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../auth/plugin.js";
import { db } from "../db/index.js";
import { adAccounts, assets, campaigns, creatives, users } from "../db/schema.js";
import { liveSubscriptionFor } from "../lib/subscriptions/index.js";
import { launchPlanBlock } from "../lib/subscriptions/policy.js";
import { decryptToken } from "../lib/crypto.js";
import { isGoogleAdsConfigured } from "../lib/googleAds/env.js";
import { mccAccessToken } from "../lib/googleAds/mcc.js";
import { GoogleOAuthError, refreshAccessToken } from "../lib/googleAds/oauth.js";
import { resolveZipCriteria } from "../lib/googleAds/campaigns.js";
import { GoogleAdsApiError, getCustomerDetails } from "../lib/googleAds/client.js";
import {
  buildAdCopy,
  findLogoAsset,
  findYoutubeVideoAsset,
  launchDemandGen,
  logoAssetName,
  type AdCopyInput,
  type LaunchPlan,
} from "../lib/googleAds/demandGen.js";
import { checkLogo } from "../lib/imageSize.js";
import { launchReviewGate } from "../lib/uploads/review.js";
import { getObjectBytes } from "../plugins/r2.js";
import { loadOwnedAdAccount, loadOwnedCampaign } from "../lib/ownership.js";
import { canLaunch, MIN_FUNDED_DAYS } from "../lib/wallet/index.js";
import { billingGate, requiresWalletCheck } from "../lib/billing/policy.js";
import { syncCardLimit } from "../lib/billing/managedCard.js";

// ---------------------------------------------------------------------------
// THE ONLY ROUTE IN THIS CODEBASE THAT SPENDS MONEY.
//
// Everything before this point — uploads, scripts, renders — is free and
// reversible. This is the boundary. Keep it that way: no other route may call
// the Google Ads mutate API, and `campaigns.status` reaches 'live' here alone.
//
// For customer-billed and BYO accounts the campaign is created PAUSED at Google
// (see lib/googleAds/demandGen.ts): the advertiser presses go in their own
// Google Ads account. A platform-billed customer has no Google access, so for
// them this Launch press IS the go-ahead and the campaign is created ENABLED —
// only after the wallet guard below has required funds.
//
// ⚠️ WHAT THIS ROUTE GOT WRONG UNTIL 2026-10-24, because the shape of the bug
// is worth keeping: it created a budget, a campaign and geo targets and then
// stopped. No ad group, no ad. Google accepted every call, the advertiser saw a
// real campaign in their account, `campaigns.status` said 'live', and the
// campaign could never show anything to anybody — enabling it would have spent
// nothing and achieved nothing. The full chain is
//
//   rendered MP4 -> YouTube video id -> Asset -> AdGroup -> AdGroupAd
//
// and the first link is a separate queue (render/youtubeUploads.ts) because a
// video ad references a YouTube video id, never an MP4 URL. All five links are
// required; four of them look like success on their own.
// ---------------------------------------------------------------------------

export async function launchRoutes(app: FastifyInstance) {
  app.addHook("onRequest", requireAuth);

  app.post(
    "/campaigns/:campaignId/launch",
    {
      schema: {
        params: z.object({ campaignId: z.string().uuid() }),
        body: z.object({
          adAccountId: z.string().uuid(),
          // Dry run: Google checks every operation and creates nothing. Skips
          // the billing and wallet gates, because nothing can spend.
          validateOnly: z.boolean().optional(),
        }),
      },
    },
    async (req, reply) => {
      if (!isGoogleAdsConfigured()) {
        // Specific code, not a generic 500: the dashboard renders this as
        // "Google Ads launch isn't available yet" rather than as a bug. See
        // infra/google-ads-setup.md for what is missing.
        return reply.code(503).send({ error: "google_ads_not_configured" });
      }

      const { campaignId } = req.params as { campaignId: string };
      const { adAccountId, validateOnly = false } = req.body as {
        adAccountId: string;
        validateOnly?: boolean;
      };

      const campaign = await loadOwnedCampaign(campaignId, req.userId!, reply);
      if (!campaign) return;

      // Idempotence guard. Without it, a double-clicked Launch button creates
      // two campaigns and two budgets at Google — the advertiser pays twice and
      // this table only remembers one of them.
      if (campaign.googleCampaignResourceName) {
        return reply.code(409).send({ error: "already_launched" });
      }

      // A paid plan that includes ads. Skipped on a dry run, like the billing
      // and wallet gates: nothing can spend.
      if (!validateOnly) {
        const [user] = await db
          .select({ marginMode: users.marginMode })
          .from(users)
          .where(eq(users.id, req.userId!))
          .limit(1);
        const sub = await liveSubscriptionFor(req.userId!);
        const block = launchPlanBlock({ role: req.userRole, marginMode: user?.marginMode, sub });
        if (block) return reply.code(402).send({ error: block });
      }

      const account = await loadOwnedAdAccount(adAccountId, req.userId!, reply);
      if (!account) return;

      // A platform account still waiting for the operator to create it in
      // Google Ads has no customer id yet. The billing gate would refuse it
      // too; checking here lets every Google call below use a definite id.
      const customerId = account.customerId;
      if (!customerId) {
        return reply.code(409).send({
          error: "provisioning_incomplete",
          detail: "This ad account is still being set up.",
        });
      }

      // -------------------------------------------------------------------
      // THE BILLING GATE. Can Google accept spend on this account at all?
      //
      // Distinct from — and prior to — the wallet guard below, which asks
      // whether WE can afford it. The case this exists for is a customer-funded
      // managed account whose owner never finished entering a card: launching
      // into it SUCCEEDS at the API level and then silently never delivers.
      // That is the worst failure available here, because the advertiser
      // believes they are live and nothing in the system disagrees.
      // -------------------------------------------------------------------
      const gate = billingGate(account);
      if (!gate.ok && !validateOnly) {
        const detail =
          gate.code === "billing_not_configured"
            ? "This account has no payment method yet. Finish the Google billing step, then launch."
            : gate.code === "billing_link_failed"
              ? "The Google account invitation could not be completed. Resend it from Settings."
              : gate.code === "provisioning_incomplete"
                ? "This ad account is still being set up."
                : gate.code === "billing_setup_pending"
                  ? "We're finishing your ad account's setup. Launch unlocks automatically, usually within a few hours."
                  : "This ad account is no longer connected.";
        return reply
          .code(gate.code === "account_revoked" ? 409 : 409)
          .send({ error: gate.code === "account_revoked" ? "ad_account_revoked" : gate.code, detail });
      }

      // -------------------------------------------------------------------
      // CURRENCY. The budget is minor units of the CAMPAIGN's currency, and
      // Google reads micros in the ACCOUNT's currency. A USD campaign launched
      // into an INR account would spend 1/83rd of what was asked; the reverse,
      // 83 times as much. Refuse rather than convert.
      // -------------------------------------------------------------------
      if (account.currencyCode && account.currencyCode !== campaign.currencyCode) {
        return reply.code(409).send({
          error: "currency_mismatch",
          detail: `This campaign's budget is in ${campaign.currencyCode} but the ad account bills in ${account.currencyCode}.`,
        });
      }

      // -------------------------------------------------------------------
      // THE WALLET GUARD. Platform-funded accounts only, and non-negotiable
      // there.
      //
      // When billing_mode is 'platform', Google bills 3PandaLabs rather than
      // the advertiser — so launching without funds means the org finances
      // someone else's advertising. Requiring MIN_FUNDED_DAYS of cover rather
      // than one day is deliberate: the spend sync runs nightly and Google
      // keeps serving until we pause it, so the guard has to lead the spend
      // rather than trail it.
      //
      // Customer-funded accounts skip this entirely — whether they are managed
      // children or brought-your-own connections, the advertiser's own card is
      // charged and the org has no exposure to bound. Note this is keyed on
      // billing mode, NOT on isManaged: a managed child the customer pays for
      // has no wallet and must not be gated on one.
      // -------------------------------------------------------------------
      if (requiresWalletCheck(account) && !validateOnly) {
        const funds = await canLaunch(req.userId!, campaign.dailyBudgetCents);
        if (!funds.ok) {
          return reply.code(402).send({
            error: "insufficient_funds",
            balanceMinor: funds.balanceMinor,
            requiredMinor: funds.requiredMinor,
            currencyCode: campaign.currencyCode,
            detail: `A campaign we fund needs ${MIN_FUNDED_DAYS} days of budget on hand before it can go live.`,
          });
        }
      }

      // At least one rendered creative. Launching with nothing to show would
      // produce a campaign that can never serve, and the advertiser would be
      // left with a budgeted shell in their Google Ads account.
      const readyRows = await db
        .select({
          id: creatives.id,
          youtubeVideoId: creatives.youtubeVideoId,
          youtubeUploadStatus: creatives.youtubeUploadStatus,
          youtubeUploadError: creatives.youtubeUploadError,
          durationSeconds: creatives.durationSeconds,
          script: creatives.script,
          reviewStatus: creatives.reviewStatus,
        })
        .from(creatives)
        .where(and(eq(creatives.campaignId, campaignId), eq(creatives.renderStatus, "ready")));

      // -------------------------------------------------------------------
      // HUMAN REVIEW OF CUSTOMER-UPLOADED VIDEOS (lib/uploads/review.ts).
      // A pending upload blocks — dry run included, since the answer would be
      // the same on the real press; a rejected one is left out of the ad.
      // AdVault-generated creatives have no review status and pass untouched.
      // -------------------------------------------------------------------
      const reviewGate = launchReviewGate(readyRows);
      if (!reviewGate.ok) {
        return reply.code(409).send({
          error: reviewGate.error,
          detail:
            reviewGate.error === "video_pending_review"
              ? "Your uploaded video is waiting for AdVault's review. Launch unlocks once it is approved."
              : "Your uploaded video was not approved, so there is nothing to launch. Upload a new one or remove it.",
        });
      }
      const ready = readyRows.filter((c) => reviewGate.eligibleIds.includes(c.id));

      if (ready.length === 0) {
        return reply.code(409).send({ error: "no_ready_creatives" });
      }

      // -------------------------------------------------------------------
      // AND AT LEAST ONE OF THEM ON YOUTUBE.
      //
      // This check is the whole reason this app could previously "launch
      // successfully" and never show an ad. A Google Ads video ad references an
      // 11-character YouTube video id — never an MP4 URL — so a creative that
      // exists only in R2 cannot be attached to anything. Without this guard,
      // the route created a budget, a campaign and geo targets, returned 200,
      // and left a budgeted shell that no amount of enabling would make serve.
      //
      // 409 rather than 503: unlike a missing credential, this is usually a
      // wait rather than a misconfiguration — the upload is queued and will
      // arrive, and the dashboard polls.
      // -------------------------------------------------------------------
      const uploaded = ready.filter((c) => c.youtubeVideoId);
      if (uploaded.length === 0) {
        const anyFailed = ready.find((c) => c.youtubeUploadStatus === "failed");
        return reply.code(409).send({
          error: anyFailed ? "youtube_upload_failed" : "youtube_upload_pending",
          detail: anyFailed
            ? `This ad could not be published to YouTube, so Google has nothing to show: ${anyFailed.youtubeUploadError ?? "unknown error"}`
            : "This ad is still being published to YouTube. Launch is available once that finishes — usually a minute or two.",
        });
      }

      // -------------------------------------------------------------------
      // A SQUARE LOGO. Google requires one on every Demand Gen video ad
      // (logo_images, mandatory since API v24): 1:1, at least 128x128.
      // Checked here, before any Google call, so the advertiser is told "add
      // a logo" rather than shown a field error from Google. The dashboard
      // crops uploads to a square, so this mostly catches older logos.
      // -------------------------------------------------------------------
      const [logo] = await db
        .select()
        .from(assets)
        .where(and(eq(assets.userId, req.userId!), eq(assets.kind, "logo")))
        .orderBy(desc(assets.createdAt))
        .limit(1);
      if (!logo) return reply.code(409).send({ error: "logo_required" });

      const logoBytes = await getObjectBytes(logo.r2Key);
      const logoCheck = checkLogo(logoBytes);
      if (!logoCheck.ok) {
        return reply.code(409).send({ error: "logo_invalid", reason: logoCheck.reason });
      }

      const fail = async (code: string, detail: string) => {
        await db
          .update(campaigns)
          .set({ status: "failed", launchError: detail, updatedAt: new Date() })
          .where(eq(campaigns.id, campaignId));
        return reply.code(502).send({ error: code, detail });
      };

      let accessToken: string;
      try {
        // A managed account has no per-user grant — the MCC's own credential
        // reaches it. An unmanaged one uses the advertiser's stored token. The
        // CHECK constraint on ad_accounts guarantees exactly one of these is
        // available, so the non-null assertion below cannot fire in practice.
        accessToken = account.isManaged
          ? await mccAccessToken()
          : await refreshAccessToken(decryptToken(account.refreshTokenCiphertext!));
      } catch (err) {
        // invalid_grant is permanent — the advertiser revoked access or
        // changed their password. Marking the row revoked lets the dashboard
        // prompt a reconnect instead of failing every future launch with the
        // same opaque message.
        if (err instanceof GoogleOAuthError && err.code === "invalid_grant") {
          await db
            .update(adAccounts)
            .set({ status: "revoked" })
            .where(eq(adAccounts.id, adAccountId));
          return reply.code(409).send({ error: "ad_account_revoked" });
        }
        req.log.error({ err, campaignId }, "failed to refresh the Google access token");
        return fail("google_auth_failed", "Could not refresh Google Ads credentials");
      }

      await db
        .update(adAccounts)
        .set({ lastRefreshedAt: new Date() })
        .where(eq(adAccounts.id, adAccountId));

      try {
        const ctx = {
          accessToken,
          customerId: customerId,
          loginCustomerId: account.loginCustomerId,
        };

        // A manager (MCC) account holds no campaigns, so a launch into it can
        // only fail. Checked live rather than trusted from the row: accounts
        // connected before the connect-time check existed may be managers —
        // the first real launch attempt was exactly that.
        const details = await getCustomerDetails(
          accessToken,
          customerId,
          account.loginCustomerId,
        );
        if (details?.isManager) {
          return reply.code(409).send({ error: "manager_account" });
        }

        // Resolved BEFORE anything is created. An ad group with no location
        // criteria targets everywhere — the single most expensive way for this
        // app to be wrong.
        const geoTargetConstants = await resolveZipCriteria({
          ...ctx,
          zipCodes: campaign.targetZipCodes,
          // 6-digit codes are Indian PINs; resolving them against the default
          // "US" would match nothing and refuse the launch. campaigns.ts
          // rejects mixed lengths, so the first code decides for all.
          countryCode: campaign.targetZipCodes[0]?.length === 6 ? "IN" : "US",
        });

        if (geoTargetConstants.length === 0) {
          return reply.code(400).send({ error: "no_resolvable_zip_codes" });
        }

        // Assets Google already has are referenced, not re-created: assets
        // are de-duplicated per account, so a second create is an error.
        const [existingLogo, videos] = await Promise.all([
          findLogoAsset(ctx, logo.id),
          Promise.all(
            uploaded.map(async (c) => {
              const existing = await findYoutubeVideoAsset(ctx, c.youtubeVideoId!);
              return existing
                ? { existing }
                : {
                    youtubeVideoId: c.youtubeVideoId!,
                    title: `${campaign.businessName} — ${campaign.name}`,
                  };
            }),
          ),
        ]);

        const plan: LaunchPlan = {
          customerId: customerId,
          nameSuffix: campaign.id.slice(0, 8),
          campaignName: campaign.name,
          dailyBudgetCents: campaign.dailyBudgetCents,
          finalUrl: campaign.landingUrl,
          geoTargetConstants,
          copy: buildAdCopy({
            businessName: campaign.businessName,
            businessCategory: campaign.businessCategory,
            callToAction: campaign.callToAction,
            offerDetails: campaign.offerDetails,
            script: (uploaded[0]!.script ?? null) as AdCopyInput["script"],
          }),
          videos,
          // A platform-billed customer has no Google Ads access, so a paused
          // campaign is one nobody could ever switch on. Their Launch press is
          // the go-ahead; the wallet guard above has already required funds,
          // and spendSync pauses the campaign when they run out.
          campaignStatus: account.billingMode === "platform" ? "ENABLED" : "PAUSED",
          logo: existingLogo
            ? { existing: existingLogo }
            : { name: logoAssetName(logo.id), base64: logoBytes.toString("base64") },
        };

        const zipCodes = {
          // Reported so the advertiser can see when a typo'd ZIP was dropped
          // rather than silently targeting fewer places than they entered.
          zipCodesRequested: campaign.targetZipCodes.length,
          zipCodesTargeted: geoTargetConstants.length,
        };

        if (validateOnly) {
          await launchDemandGen(ctx, plan, { validateOnly: true });
          return { validateOnly: true, ok: true, ...zipCodes, adCopy: plan.copy, videos: videos.length };
        }

        // ONE atomic request: budget, campaign, ad group, locations, assets
        // and the ad all exist at Google afterwards, or none of them do. So
        // there is no half-built campaign to record or unwind, and the row is
        // written once, after Google has accepted the whole thing.
        const result = (await launchDemandGen(ctx, plan))!;

        const [updated] = await db
          .update(campaigns)
          .set({
            adAccountId,
            googleCustomerId: customerId,
            googleBudgetResourceName: result.budgetResourceName,
            googleCampaignResourceName: result.campaignResourceName,
            googleAdGroupResourceName: result.adGroupResourceName,
            status: "live",
            launchError: null,
            launchedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(campaigns.id, campaignId))
          .returning();

        // Every published cut is in the one ad, so each creative points at it.
        // This is also what stops a live creative being re-published.
        await db
          .update(creatives)
          .set({ googleAdResourceName: result.adResourceName })
          .where(inArray(creatives.id, uploaded.map((c) => c.id)));

        // A platform customer's card limit tracks what they have live. Never
        // throws; a failure is logged and the old limit stays.
        if (account.billingMode === "platform") {
          await syncCardLimit(req.userId!).catch((err) =>
            req.log.error({ err }, "card limit sync after launch failed"),
          );
        }

        return {
          campaign: updated,
          ...zipCodes,
          adsAttached: uploaded.length,
          // Said plainly in the response as well as the UI.
          note:
            plan.campaignStatus === "ENABLED"
              ? "Your campaign is live. Google reviews new ads first, usually within a day, then they start showing."
              : "Campaign created in PAUSED state with its ad attached. Review it in Google Ads and enable it when ready.",
        };
      } catch (err) {
        const detail = describeGoogleAdsError(err);
        req.log.error({ err, campaignId, validateOnly }, "Google Ads campaign creation failed");
        // A dry run changes nothing, including this campaign's status.
        if (validateOnly) return reply.code(502).send({ error: "google_ads_error", detail });
        return fail("google_ads_error", detail);
      }
    },
  );
}

type GoogleAdsFailure = {
  errors?: {
    message?: string;
    location?: { fieldPathElements?: { fieldName?: string }[] };
  }[];
};

// Google's top-level message is always "Request contains an invalid argument";
// the useful part is the per-field list underneath. Kept on the campaign row
// so a failed launch can be diagnosed from the database, not only the logs.
function describeGoogleAdsError(err: unknown): string {
  if (err instanceof GoogleAdsApiError && Array.isArray(err.details)) {
    const failures = (err.details as GoogleAdsFailure[])
      .flatMap((d) => d.errors ?? [])
      .map((e) => {
        const field = e.location?.fieldPathElements
          ?.map((p) => p.fieldName)
          .filter(Boolean)
          .join(".");
        return field ? `${e.message} (${field})` : e.message;
      })
      .filter(Boolean);
    if (failures.length > 0) return failures.join("; ").slice(0, 1000);
  }
  return err instanceof Error ? err.message : String(err);
}

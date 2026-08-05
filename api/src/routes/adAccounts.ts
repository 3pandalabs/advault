import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../auth/plugin.js";
import { db } from "../db/index.js";
import { adAccounts, users } from "../db/schema.js";
import { encryptToken } from "../lib/crypto.js";
import { isOAuthConfigured, isGoogleAdsConfigured } from "../lib/googleAds/env.js";
import {
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  revokeRefreshToken,
} from "../lib/googleAds/oauth.js";
import { issueOAuthState, verifyOAuthState } from "../lib/googleAds/oauthState.js";
import { getCustomerDetails, listAccessibleCustomers } from "../lib/googleAds/client.js";
import { decryptToken } from "../lib/crypto.js";
import { loadOwnedAdAccount } from "../lib/ownership.js";
import { createChildAccount, defaultTimeZone, isMccConfigured } from "../lib/googleAds/mcc.js";
import { billingSetupUrl } from "../lib/googleAds/billingLink.js";
import {
  attachPlatformBillingToAccount,
  NoMccPaymentsAccount,
  refreshCustomerBillingLink,
  startCustomerBillingLink,
} from "../lib/billing/link.js";
import {
  offeredModes,
  offeredModeList,
  resolveRequestedMode,
  shouldPromptForMode,
  canSwitchMode,
  needsBillingLinkPolling,
  type BillingMode,
} from "../lib/billing/policy.js";
import type { Currency } from "../lib/pricing/index.js";

/** What this deployment offers — recomputed per request so a config change lands without a restart. */
function currentOfferedModes() {
  return offeredModes({
    configured: process.env.ADVAULT_BILLING_MODES,
    mccConfigured: isMccConfigured(),
  });
}

// A stored Google Ads refresh token authorises spending an advertiser's money.
// This serializer is the ONLY shape an ad_accounts row may leave the API in —
// extend it rather than hand-rolling a response, and never add the ciphertext
// or any part of a token to it.
function toPublicAdAccount(row: typeof adAccounts.$inferSelect) {
  return {
    id: row.id,
    provider: row.provider,
    customerId: row.customerId,
    descriptiveName: row.descriptiveName,
    currencyCode: row.currencyCode,
    timeZone: row.timeZone,
    isTestAccount: row.isTestAccount,
    status: row.status,
    connectedAt: row.connectedAt,
    lastRefreshedAt: row.lastRefreshedAt,
    // Which of the two shapes this is. The dashboard renders them very
    // differently: a managed account has no Connect button and no "you will
    // lose access to your own Google Ads" warning on disconnect.
    isManaged: row.isManaged,
    provisionStatus: row.provisionStatus,
    provisionError: row.provisionError,
    // Who pays Google. The dashboard shows a wallet and a top-up prompt for
    // 'platform' and neither for 'customer', so getting this wrong shows an
    // advertiser a balance that has nothing to do with their campaigns.
    billingMode: row.billingMode,
    billingLinkStatus: row.billingLinkStatus,
    billingConfirmedAt: row.billingConfirmedAt,
    // Only meaningful mid-handshake, but cheap and stable, and it saves the
    // dashboard from reconstructing a Google URL itself.
    billingUrl:
      row.isManaged && row.billingMode === "customer" ? billingSetupUrl(row.customerId) : null,
  };
}

export async function adAccountRoutes(app: FastifyInstance) {
  app.addHook("onRequest", requireAuth);

  // ---------------------------------------------------------------------
  // Managed (MCC) provisioning — the "never see Google Ads" path.
  //
  // Creates a child customer under the 3PandaLabs manager account. The
  // advertiser gets an ad account without ever visiting Google, and billing
  // sits on the MCC — which is exactly why the wallet guard in routes/launch.ts
  // is not optional. This endpoint creates the account; it does not spend.
  // ---------------------------------------------------------------------
  app.post("/ad-accounts/managed", async (req, reply) => {
    if (!isMccConfigured()) {
      // Specific code so the dashboard says "not switched on yet" rather than
      // rendering a bug. The MCC needs an approved developer token, which is a
      // manual review — see infra/google-ads-setup.md.
      return reply.code(503).send({ error: "google_ads_mcc_not_configured" });
    }

    const body = z
      .object({ billingMode: z.enum(["platform", "customer"]).optional() })
      .safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_billing_mode" });

    // With both modes offered the advertiser must have chosen. Defaulting here
    // would silently put one of them on our credit card.
    const resolved = resolveRequestedMode(body.data.billingMode, currentOfferedModes());
    if (!resolved.ok) return reply.code(400).send({ error: resolved.code });
    const billingMode: BillingMode = resolved.mode;

    const [user] = await db
      .select({
        businessName: users.businessName,
        email: users.email,
        currencyCode: users.currencyCode,
      })
      .from(users)
      .where(eq(users.id, req.userId!))
      .limit(1);

    // One managed account per advertiser. A second would silently split their
    // campaigns and their spend across two children, and only one of them
    // would be visible on the dashboard.
    const [existing] = await db
      .select()
      .from(adAccounts)
      .where(and(eq(adAccounts.userId, req.userId!), eq(adAccounts.isManaged, true)))
      .limit(1);
    if (existing && existing.provisionStatus !== "failed") {
      return reply.code(200).send(toPublicAdAccount(existing));
    }

    const currency = user.currencyCode as Currency;
    try {
      const result = await createChildAccount({
        descriptiveName: user.businessName ?? user.email,
        currency,
        // Immutable at Google once set — derived from the market rather than a
        // form field, because a wrong value means a whole new account.
        timeZone: defaultTimeZone(currency),
      });

      const [row] = await db
        .insert(adAccounts)
        .values({
          userId: req.userId!,
          provider: "google_ads",
          customerId: result.customerId,
          descriptiveName: user.businessName ?? null,
          currencyCode: currency,
          timeZone: defaultTimeZone(currency),
          loginCustomerId: result.managerCustomerId,
          managerCustomerId: result.managerCustomerId,
          isManaged: true,
          // Null for managed accounts — no per-user grant exists or is needed.
          // The CHECK constraint enforces this pairing.
          refreshTokenCiphertext: null,
          isTestAccount: "unknown",
          status: "active",
          provisionStatus: "active",
          provisionedAt: new Date(),
          billingMode,
          // Customer-funded children start the invitation handshake below;
          // platform-funded ones must leave this null (schema CHECK).
          billingLinkStatus: billingMode === "customer" ? "pending" : null,
        })
        .onConflictDoUpdate({
          target: [adAccounts.userId, adAccounts.provider, adAccounts.customerId],
          set: { provisionStatus: "active", provisionError: null, provisionedAt: new Date() },
        })
        .returning();

      // The account exists at this point. Billing attachment is a second round
      // trip that can fail on its own, and its failure must not undo a
      // successful provision — so it is recorded on the row and surfaced, not
      // thrown. Both branches return 201.
      if (billingMode === "platform") {
        try {
          await attachPlatformBillingToAccount(row);
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          req.log.error({ err, adAccountId: row.id }, "platform billing attach failed");

          // No payments account on the MCC is an operator problem that will
          // break every platform signup identically until someone fixes it.
          // Surfaced distinctly so it does not read as this advertiser's fault.
          const code =
            err instanceof NoMccPaymentsAccount ? "mcc_has_no_payments_account" : "billing_attach_failed";
          const [fresh] = await db
            .select()
            .from(adAccounts)
            .where(eq(adAccounts.id, row.id))
            .limit(1);
          return reply
            .code(201)
            .send({ ...toPublicAdAccount(fresh ?? row), billingWarning: code, billingDetail: detail });
        }
      } else {
        const link = await startCustomerBillingLink(row, user.email);
        const [fresh] = await db.select().from(adAccounts).where(eq(adAccounts.id, row.id)).limit(1);
        return reply.code(201).send({
          ...toPublicAdAccount(fresh ?? row),
          // The two things the wizard needs to render step 6 and step 7.
          billingUrl: link.billingUrl,
          invitationSent: link.invitationSent,
          ...(link.detail ? { billingDetail: link.detail } : {}),
        });
      }

      const [fresh] = await db.select().from(adAccounts).where(eq(adAccounts.id, row.id)).limit(1);
      return reply.code(201).send(toPublicAdAccount(fresh ?? row));
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      req.log.error({ err }, "MCC child account provisioning failed");

      // Recorded rather than swallowed: the advertiser sees why, and a retry is
      // possible because the `failed` row is not treated as an existing account
      // by the guard above.
      await db
        .insert(adAccounts)
        .values({
          userId: req.userId!,
          provider: "google_ads",
          customerId: `pending-${Date.now()}`.slice(0, 20).replace(/\D/g, "") || "00000",
          isManaged: true,
          refreshTokenCiphertext: null,
          status: "revoked",
          provisionStatus: "failed",
          provisionError: detail.slice(0, 500),
        })
        .onConflictDoNothing();

      return reply.code(502).send({ error: "provisioning_failed", detail });
    }
  });

  // ---------------------------------------------------------------------
  // Billing mode — the onboarding branch.
  //
  // `prompt` is what decides whether the wizard shows a choice step at all.
  // With one mode offered there is nothing to ask, and asking anyway is a
  // question with one answer.
  // ---------------------------------------------------------------------
  app.get("/ad-accounts/billing-options", async () => {
    const offered = currentOfferedModes();
    return {
      modes: offeredModeList(offered),
      prompt: shouldPromptForMode(offered),
      mccConfigured: isMccConfigured(),
    };
  });

  // Polled by the wizard while the advertiser is off in Google accepting an
  // invitation and entering a card. Billing setup is the authority — see the
  // note in lib/billing/link.ts on why invitation state alone is ambiguous.
  app.get<{ Params: { adAccountId: string } }>(
    "/ad-accounts/:adAccountId/billing-status",
    async (req, reply) => {
      const account = await loadOwnedAdAccount(req.params.adAccountId, req.userId!, reply);
      if (!account) return;

      if (!needsBillingLinkPolling(account)) {
        // Terminal or not applicable — answer from the row rather than
        // spending a Google call on an account that cannot change.
        return {
          ...toPublicAdAccount(account),
          billingConfigured: account.billingLinkStatus === "active",
          polling: false,
        };
      }

      const [user] = await db
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, req.userId!))
        .limit(1);

      const snapshot = await refreshCustomerBillingLink(account, user.email);
      const [fresh] = await db
        .select()
        .from(adAccounts)
        .where(eq(adAccounts.id, account.id))
        .limit(1);

      return {
        ...toPublicAdAccount(fresh ?? account),
        billingConfigured: snapshot.billingConfigured,
        invitationState: snapshot.invitationState,
        polling: snapshot.status !== "active",
        ...(snapshot.detail ? { billingDetail: snapshot.detail } : {}),
      };
    },
  );

  // The invitation email is the classic silent failure in this flow — spam
  // filtered, wrong address, or simply lost. Resend is cheap and idempotent at
  // Google (a second invitation supersedes the first), so there is no reason to
  // make an advertiser wait it out.
  app.post<{ Params: { adAccountId: string } }>(
    "/ad-accounts/:adAccountId/billing/resend-invite",
    async (req, reply) => {
      const account = await loadOwnedAdAccount(req.params.adAccountId, req.userId!, reply);
      if (!account) return;

      if (!account.isManaged || account.billingMode !== "customer") {
        return reply.code(409).send({ error: "no_billing_invitation_for_account" });
      }
      if (account.billingLinkStatus === "active") {
        return reply.code(409).send({ error: "billing_already_configured" });
      }

      const [user] = await db
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, req.userId!))
        .limit(1);

      const link = await startCustomerBillingLink(account, user.email);
      const [fresh] = await db
        .select()
        .from(adAccounts)
        .where(eq(adAccounts.id, account.id))
        .limit(1);

      return reply.code(link.invitationSent ? 200 : 502).send({
        ...toPublicAdAccount(fresh ?? account),
        billingUrl: link.billingUrl,
        invitationSent: link.invitationSent,
        ...(link.detail ? { billingDetail: link.detail } : {}),
      });
    },
  );

  // Moving between modes after onboarding. Only managed accounts can switch —
  // there is nothing to attach our billing to on a brought-your-own connection,
  // and the schema CHECK says the same thing one layer down.
  app.post<{ Params: { adAccountId: string } }>(
    "/ad-accounts/:adAccountId/billing-mode",
    async (req, reply) => {
      const body = z.object({ billingMode: z.enum(["platform", "customer"]) }).safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: "invalid_billing_mode" });

      const account = await loadOwnedAdAccount(req.params.adAccountId, req.userId!, reply);
      if (!account) return;

      const decision = canSwitchMode(account, body.data.billingMode, currentOfferedModes());
      if (!decision.ok) {
        return reply.code(decision.code === "same_mode" ? 200 : 409).send(
          decision.code === "same_mode" ? toPublicAdAccount(account) : { error: decision.code },
        );
      }

      const [user] = await db
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, req.userId!))
        .limit(1);

      if (body.data.billingMode === "platform") {
        // Flip the row first so the CHECK constraint permits clearing the
        // handshake columns, then attach. A failed attach leaves a
        // platform-mode account with no payments account, which the launch
        // guard does not catch — so it is surfaced as a warning, loudly.
        await db
          .update(adAccounts)
          .set({ billingMode: "platform", billingLinkStatus: null })
          .where(eq(adAccounts.id, account.id));

        const [flipped] = await db
          .select()
          .from(adAccounts)
          .where(eq(adAccounts.id, account.id))
          .limit(1);

        try {
          await attachPlatformBillingToAccount(flipped);
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          req.log.error({ err, adAccountId: account.id }, "billing mode switch to platform failed");
          return reply.code(502).send({ error: "billing_attach_failed", detail });
        }
      } else {
        await db
          .update(adAccounts)
          .set({ billingMode: "customer", billingLinkStatus: "pending", billingConfirmedAt: null })
          .where(eq(adAccounts.id, account.id));

        const [flipped] = await db
          .select()
          .from(adAccounts)
          .where(eq(adAccounts.id, account.id))
          .limit(1);

        const link = await startCustomerBillingLink(flipped, user.email);
        const [fresh] = await db
          .select()
          .from(adAccounts)
          .where(eq(adAccounts.id, account.id))
          .limit(1);
        return reply.code(200).send({
          ...toPublicAdAccount(fresh ?? flipped),
          billingUrl: link.billingUrl,
          invitationSent: link.invitationSent,
        });
      }

      const [fresh] = await db
        .select()
        .from(adAccounts)
        .where(eq(adAccounts.id, account.id))
        .limit(1);
      return reply.code(200).send(toPublicAdAccount(fresh ?? account));
    },
  );

  app.get("/ad-accounts", async (req) => {
    const rows = await db.select().from(adAccounts).where(eq(adAccounts.userId, req.userId!));
    return {
      // Surfaced so the dashboard can say "Google Ads setup pending" rather
      // than showing a Connect button that leads to a 503. See
      // infra/google-ads-setup.md — the developer token is a manual review and
      // is the slow part of standing this app up.
      configured: isGoogleAdsConfigured(),
      accounts: rows.map(toPublicAdAccount),
    };
  });

  // Step one of the OAuth dance. The URL is built server-side so the client id
  // and the exact redirect URI live in one place — Google compares the whole
  // redirect string, so a client-side copy is a drift waiting to happen.
  app.get("/ad-accounts/google/authorize-url", async (req, reply) => {
    if (!isOAuthConfigured()) {
      return reply.code(503).send({ error: "google_ads_not_configured" });
    }
    // Signed, single-use, 10-minute, bound to this user. Without it the
    // callback is a CSRF primitive that attaches an attacker's ad account to a
    // victim's login — see lib/googleAds/oauthState.ts.
    return { url: buildAuthorizeUrl(issueOAuthState(req.userId!)) };
  });

  // Step two. The web app's /oauth/google/callback page forwards the code and
  // state here rather than the browser hitting Google's token endpoint — the
  // client secret must never reach a browser bundle.
  app.post(
    "/ad-accounts/google/callback",
    {
      schema: {
        body: z.object({
          code: z.string().min(1).max(2000),
          state: z.string().min(1).max(500),
          // Optional: which customer to connect, when the grant can reach
          // several. Omitted on the first call, which returns the list.
          customerId: z.string().regex(/^\d{5,20}$/).optional(),
        }),
      },
    },
    async (req, reply) => {
      if (!isOAuthConfigured()) {
        return reply.code(503).send({ error: "google_ads_not_configured" });
      }

      const body = req.body as { code: string; state: string; customerId?: string };

      // The state's user id is authoritative — NOT req.userId. They will
      // normally match, and a mismatch means the callback is being replayed
      // under a different session, which is exactly the attack the state
      // parameter exists to stop.
      const stateUserId = verifyOAuthState(body.state);
      if (!stateUserId || stateUserId !== req.userId) {
        return reply.code(400).send({ error: "invalid_state" });
      }

      const tokens = await exchangeCodeForTokens(body.code).catch(() => null);
      if (!tokens) return reply.code(400).send({ error: "token_exchange_failed" });

      // Absent when Google has already granted this client offline access and
      // prompt=consent was somehow dropped. There is nothing to store and
      // nothing to refresh with later, so fail loudly now rather than saving a
      // connection that cannot survive the hour.
      if (!tokens.refresh_token) {
        return reply.code(400).send({ error: "no_refresh_token_returned" });
      }

      const accessible = await listAccessibleCustomers(tokens.access_token).catch(() => []);
      const customerIds = accessible.map((n) => n.split("/").pop()!).filter(Boolean);

      if (customerIds.length === 0) {
        return reply.code(400).send({ error: "no_accessible_customers" });
      }

      // More than one and no choice made: hand the list back so the advertiser
      // picks. The code is single-use, so the client re-POSTs with the same
      // code only in the single-account case — the multi-account path needs a
      // fresh authorize round trip, which the dashboard does.
      if (!body.customerId && customerIds.length > 1) {
        return reply.code(200).send({ needsSelection: true, customerIds });
      }

      const customerId = body.customerId ?? customerIds[0];
      // Guards against a caller pairing a valid code with a customer id the
      // grant cannot actually reach.
      if (!customerIds.includes(customerId)) {
        return reply.code(400).send({ error: "customer_not_accessible" });
      }

      const details = await getCustomerDetails(tokens.access_token, customerId).catch(() => null);

      const [row] = await db
        .insert(adAccounts)
        .values({
          userId: req.userId!,
          provider: "google_ads",
          customerId,
          descriptiveName: details?.descriptiveName ?? null,
          currencyCode: details?.currencyCode ?? null,
          timeZone: details?.timeZone ?? null,
          isTestAccount: details ? (details.isTestAccount ? "yes" : "no") : "unknown",
          // AES-256-GCM. The column holds ciphertext, never a usable token, so
          // a database dump alone does not hand the reader an ad account.
          refreshTokenCiphertext: encryptToken(tokens.refresh_token),
          scope: tokens.scope ?? null,
          status: "active",
          lastRefreshedAt: new Date(),
        })
        // Reconnecting the same account replaces the ciphertext rather than
        // accumulating rows — each stale token would otherwise remain
        // independently usable until it expired.
        .onConflictDoUpdate({
          target: [adAccounts.userId, adAccounts.provider, adAccounts.customerId],
          set: {
            refreshTokenCiphertext: encryptToken(tokens.refresh_token),
            descriptiveName: details?.descriptiveName ?? null,
            currencyCode: details?.currencyCode ?? null,
            timeZone: details?.timeZone ?? null,
            isTestAccount: details ? (details.isTestAccount ? "yes" : "no") : "unknown",
            scope: tokens.scope ?? null,
            status: "active",
            lastRefreshedAt: new Date(),
          },
        })
        .returning();

      return reply.code(201).send(toPublicAdAccount(row));
    },
  );

  app.delete(
    "/ad-accounts/:adAccountId",
    { schema: { params: z.object({ adAccountId: z.string().uuid() }) } },
    async (req, reply) => {
      const { adAccountId } = req.params as { adAccountId: string };
      const account = await loadOwnedAdAccount(adAccountId, req.userId!, reply);
      if (!account) return;

      // Tell Google to drop the grant too, best-effort. A decrypt failure here
      // means the encryption key rotated — the local row still goes, which is
      // the part that matters, and the advertiser can revoke from their Google
      // account settings.
      // Managed accounts have no grant to revoke — the MCC owns them, and the
      // child account itself is not deleted here (Google keeps it under the
      // manager; cancelling it is a separate, deliberate act).
      if (!account.isManaged && account.refreshTokenCiphertext) {
        try {
          await revokeRefreshToken(decryptToken(account.refreshTokenCiphertext));
        } catch (err) {
          req.log.warn({ err, adAccountId }, "failed to revoke the Google refresh token");
        }
      }

      await db.delete(adAccounts).where(eq(adAccounts.id, adAccountId));
      return reply.code(204).send();
    },
  );
}

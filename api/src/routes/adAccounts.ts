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
import type { Currency } from "../lib/pricing/index.js";

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
        })
        .onConflictDoUpdate({
          target: [adAccounts.userId, adAccounts.provider, adAccounts.customerId],
          set: { provisionStatus: "active", provisionError: null, provisionedAt: new Date() },
        })
        .returning();

      return reply.code(201).send(toPublicAdAccount(row));
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

import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../auth/plugin.js";
import { parseRefreshToken, signAccessToken } from "../auth/jwt.js";
import { hashSecret, verifySecret } from "../auth/password.js";
import { accessTokenFor, issueSession } from "../auth/session.js";
import { db } from "../db/index.js";
import { sessions, users } from "../db/schema.js";
import { deleteAccount, deletionPreview } from "../lib/accountDeletion.js";
import { confirmPasswordReset, requestPasswordReset } from "../lib/passwordReset/index.js";
import { mayToggleTestMode } from "../lib/testMode/policy.js";
import { env } from "../env.js";
import { acceptedTermsVersion, recordTermsAcceptance } from "../lib/compliance/index.js";
import { TERMS_VERSION } from "../lib/compliance/texts.js";
import { knownCampaignId } from "../lib/siteVisits/index.js";
import { normalizePhone } from "../lib/phone/index.js";
import { whatsAppStateFor } from "../lib/offers/index.js";

// Password reset (2026-11-18): email a single-use, 30-minute link, then set a
// new password. Reuses lib/passwordReset — the same core the SiteVault-proxied
// routes use (routes/sitevaultAuth.ts) — and sends through the shared gateway
// from passwordReset@3pandalabs.com (Option A verified 3pandalabs.com in Resend,
// which unblocked this). Enumeration-safe: request always answers 204.

const credentials = z.object({
  email: z.string().email().max(320),
  password: z.string().min(10).max(200),
});

const loginCredentials = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(200),
});

export async function authRoutes(app: FastifyInstance) {
  app.post(
    "/auth/register",
    {
      schema: {
        body: credentials.extend({
          displayName: z.string().min(1).max(120).optional(),
          businessName: z.string().min(1).max(160).optional(),
          businessCategory: z.string().min(1).max(80).optional(),
          // The signup checkbox "I agree to the Terms of Service" sends the
          // version it showed (lib/compliance). Recorded in terms_acceptances
          // when it is the current one; otherwise the dashboard asks again.
          termsVersion: z.string().max(40).optional(),
          // The campaign whose ad brought them (0045, lib/siteVisits): the web
          // app remembers utm_campaign for 30 days. Unknown ids are ignored.
          adCampaignId: z.string().max(64).optional(),
          // Optional mobile for WhatsApp (0048): any format with a country
          // code, stored as E.164. The opt-in tick needs a phone.
          phone: z.string().max(40).optional(),
          whatsappOptIn: z.boolean().optional(),
        }),
      },
    },
    async (req, reply) => {
      const body = req.body as z.infer<typeof credentials> & {
        displayName?: string;
        businessName?: string;
        businessCategory?: string;
        termsVersion?: string;
        adCampaignId?: string;
        phone?: string;
        whatsappOptIn?: boolean;
      };
      const rawPhone = body.phone?.trim() ? body.phone : null;
      const phone = rawPhone ? normalizePhone(rawPhone) : null;
      if (rawPhone && !phone) return reply.code(400).send({ error: "invalid_phone" });
      if (body.whatsappOptIn && !phone) return reply.code(400).send({ error: "whatsapp_opt_in_needs_phone" });
      const signupCampaignId = await knownCampaignId(body.adCampaignId);

      const [user] = await db
        .insert(users)
        .values({
          email: body.email.toLowerCase(),
          passwordHash: await hashSecret(body.password),
          displayName: body.displayName,
          businessName: body.businessName,
          businessCategory: body.businessCategory,
          signupCampaignId,
          phone,
          whatsappOptInAt: body.whatsappOptIn && phone ? new Date() : null,
        })
        .onConflictDoNothing({ target: users.email })
        .returning({ id: users.id, role: users.role });

      // onConflictDoNothing rather than letting the unique violation surface as
      // a distinct "email already registered": that response is an account
      // enumeration oracle. An existing address gets the same generic answer a
      // caller would get for any rejected registration.
      if (!user) return reply.code(409).send({ error: "registration_failed" });
      if (body.termsVersion === TERMS_VERSION) await recordTermsAcceptance(user.id, TERMS_VERSION, req);

      return reply.code(201).send({
        accessToken: signAccessToken({ sub: user.id, role: user.role as "advertiser" | "admin" }),
        refreshToken: await issueSession(user.id),
      });
    },
  );

  // Login takes any length: the 10-char minimum is a sign-up rule, and accounts
  // created on SiteVault (shared 3PandaLabs account) may have 8 or 9.
  app.post("/auth/login", { schema: { body: loginCredentials } }, async (req, reply) => {
    const { email, password } = req.body as z.infer<typeof loginCredentials>;
    const [user] = await db
      .select({ id: users.id, passwordHash: users.passwordHash, role: users.role, testOwnerId: users.testOwnerId })
      .from(users)
      .where(eq(users.email, email.toLowerCase()))
      .limit(1);

    // Hash a dummy value when the user doesn't exist so response time doesn't
    // distinguish "no such account" from "wrong password".
    if (!user) {
      await verifySecret(password, "$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidiu");
      return reply.code(401).send({ error: "invalid_credentials" });
    }
    if (!(await verifySecret(password, user.passwordHash))) {
      return reply.code(401).send({ error: "invalid_credentials" });
    }
    // An admin's test customer (0030) is only entered by switching from the
    // admin. Its password is random and unknown; this is the belt to that.
    if (user.testOwnerId) return reply.code(401).send({ error: "invalid_credentials" });

    return {
      accessToken: signAccessToken({ sub: user.id, role: user.role as "advertiser" | "admin" }),
      refreshToken: await issueSession(user.id),
    };
  });

  // Password reset. `request` always answers 204 (enumeration-safe); `confirm`
  // sets the new password from a single-use token. The abuse backstop is the
  // gateway's per-app daily quota — there is no per-IP limiter here, matching
  // login/register (Cloudflare sits in front of the public host).
  app.post(
    "/auth/password-reset/request",
    { schema: { body: z.object({ email: z.string().email().max(320) }) } },
    async (req, reply) => {
      const { email } = req.body as { email: string };
      await requestPasswordReset(
        db,
        email,
        { productName: "AdVault", fromName: "AdVault", resetUrlBase: `${env.WEB_ORIGIN}/reset-password` },
        (m) => req.log.info(m),
      );
      return reply.code(204).send();
    },
  );

  app.post(
    "/auth/password-reset/confirm",
    { schema: { body: z.object({ token: z.string().min(1).max(500), password: z.string().min(10).max(200) }) } },
    async (req, reply) => {
      const { token, password } = req.body as { token: string; password: string };
      const r = await confirmPasswordReset(db, token, password);
      if (!r.ok) return reply.code(400).send({ error: "invalid_or_expired_token" });
      return reply.code(204).send();
    },
  );

  app.post(
    "/auth/refresh",
    { schema: { body: z.object({ refreshToken: z.string().min(1) }) } },
    async (req, reply) => {
      const parsed = parseRefreshToken((req.body as { refreshToken: string }).refreshToken);
      if (!parsed) return reply.code(401).send({ error: "invalid_refresh_token" });

      const [session] = await db
        .select()
        .from(sessions)
        .where(eq(sessions.id, parsed.sessionId))
        .limit(1);

      if (
        !session ||
        session.expiresAt.getTime() < Date.now() ||
        !(await verifySecret(parsed.secret, session.refreshTokenHash))
      ) {
        return reply.code(401).send({ error: "invalid_refresh_token" });
      }

      const [user] = await db
        .select({ id: users.id, role: users.role, testOwnerId: users.testOwnerId })
        .from(users)
        .where(eq(users.id, session.userId))
        .limit(1);
      if (!user) return reply.code(401).send({ error: "invalid_refresh_token" });

      // A test customer's session (0030) lives only while its owner is still
      // an admin: demoting or deleting the admin ends it.
      if (user.testOwnerId) {
        const [owner] = await db
          .select({ role: users.role, deletedAt: users.deletedAt })
          .from(users)
          .where(eq(users.id, user.testOwnerId))
          .limit(1);
        if (!owner || owner.deletedAt || owner.role !== "admin") {
          await db.delete(sessions).where(eq(sessions.id, session.id));
          return reply.code(401).send({ error: "invalid_refresh_token" });
        }
      }

      // Rotate: the presented token is destroyed and a new one issued, so a
      // stolen refresh token is usable at most once and the theft shows up as
      // the real advertiser being logged out.
      await db.delete(sessions).where(eq(sessions.id, session.id));

      return {
        // Carries `testOwner` for a test customer, so "Back to admin" survives refreshes.
        accessToken: accessTokenFor(user),
        refreshToken: await issueSession(user.id),
      };
    },
  );

  app.post(
    "/auth/logout",
    { schema: { body: z.object({ refreshToken: z.string().min(1) }) } },
    async (req, reply) => {
      const parsed = parseRefreshToken((req.body as { refreshToken: string }).refreshToken);
      if (parsed) await db.delete(sessions).where(eq(sessions.id, parsed.sessionId));
      // Always 204 — whether the token existed is not the caller's business.
      return reply.code(204).send();
    },
  );

  app.get("/auth/me", { preHandler: requireAuth }, async (req, reply) => {
    const [user] = await db
      .select({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        businessName: users.businessName,
        businessCategory: users.businessCategory,
        phone: users.phone,
        role: users.role,
        // Admin "Test as customer" (lib/testMode): billed like a customer, $0.50 charges.
        testAsCustomer: users.testAsCustomer,
        // An admin's test customer (0030): the dashboard shows "Testing as …".
        testOwnerId: users.testOwnerId,
        // 3PandaLabs' own account (0032): the dashboard shows "Internal · <label>".
        isInternal: users.isInternal,
        internalLabel: users.internalLabel,
        whatsappOptInAt: users.whatsappOptInAt,
        createdAt: users.createdAt,
        // Shared 3PandaLabs account: where it was made, and whether it has a
        // SiteVault website (the dashboard links one).
        signupApp: users.signupApp,
        sitevaultFirstUsedAt: users.sitevaultFirstUsedAt,
      })
      .from(users)
      .where(eq(users.id, req.userId!))
      .limit(1);
    if (!user) return reply.code(404).send({ error: "not_found" });
    const { sitevaultFirstUsedAt, testOwnerId, whatsappOptInAt, ...rest } = user;
    // Terms of Service (lib/compliance): the dashboard blocks on a re-accept
    // screen while accepted !== current.
    const accepted = await acceptedTermsVersion(req.userId!);
    return {
      ...rest,
      // WhatsApp for offer changes (0048): number, opt-in, and whether the
      // loop answers them (the public number only when it does).
      whatsapp: await whatsAppStateFor({ id: user.id, phone: user.phone, whatsappOptInAt, isInternal: user.isInternal }),
      usesSitevault: sitevaultFirstUsedAt !== null,
      isTestCustomer: testOwnerId !== null,
      terms: { accepted, current: TERMS_VERSION, ok: accepted === TERMS_VERSION },
    };
  });

  // Accept the current Terms of Service (signup checkbox for older accounts,
  // or the dashboard's re-accept screen after TERMS_VERSION changes). Appends
  // to terms_acceptances with IP and user agent; never updates a row.
  app.post(
    "/auth/me/terms",
    { preHandler: requireAuth, schema: { body: z.object({ version: z.string().max(40) }) } },
    async (req, reply) => {
      const { version } = req.body as { version: string };
      if (version !== TERMS_VERSION) {
        return reply.code(409).send({ error: "terms_version_mismatch", current: TERMS_VERSION });
      }
      if ((await acceptedTermsVersion(req.userId!)) !== TERMS_VERSION) {
        await recordTermsAcceptance(req.userId!, TERMS_VERSION, req);
      }
      return { terms: { accepted: TERMS_VERSION, current: TERMS_VERSION, ok: true } };
    },
  );

  app.patch(
    "/auth/me",
    {
      preHandler: requireAuth,
      schema: {
        body: z.object({
          displayName: z.string().min(1).max(120).nullish(),
          businessName: z.string().min(1).max(160).nullish(),
          businessCategory: z.string().min(1).max(80).nullish(),
          // E.164 after normalizePhone; null (or "") removes it and the opt-in.
          phone: z.string().max(40).nullish(),
          // "Message me on WhatsApp about my ads": true stamps
          // whatsapp_opt_in_at (needs a phone), false clears it.
          whatsappOptIn: z.boolean().optional(),
        }),
      },
    },
    async (req, reply) => {
      const { whatsappOptIn, phone: rawPhone, ...profile } = req.body as Record<string, string | null | undefined> & {
        whatsappOptIn?: boolean;
      };
      // Only the profile fields above — email and role are deliberately absent,
      // so this route can never escalate a role or hijack an address.
      // zod strips anything else, so `{}` or `{ email }` arrive empty; drizzle
      // throws on an empty set(), which was a 500.
      const set: Record<string, unknown> = Object.fromEntries(Object.entries(profile).filter(([, v]) => v !== undefined));
      if (rawPhone !== undefined) {
        if (rawPhone === null || !rawPhone.trim()) {
          set.phone = null;
          set.whatsappOptInAt = null; // no number, no WhatsApp
        } else {
          const phone = normalizePhone(rawPhone);
          if (!phone) return reply.code(400).send({ error: "invalid_phone" });
          set.phone = phone;
        }
      }
      if (whatsappOptIn !== undefined) {
        if (whatsappOptIn) {
          let phone = set.phone as string | null | undefined;
          if (phone === undefined) {
            const [cur] = await db.select({ phone: users.phone }).from(users).where(eq(users.id, req.userId!)).limit(1);
            phone = cur?.phone ?? null;
          }
          if (!phone) return reply.code(400).send({ error: "whatsapp_opt_in_needs_phone" });
          const [cur] = await db.select({ at: users.whatsappOptInAt }).from(users).where(eq(users.id, req.userId!)).limit(1);
          if (!cur?.at) set.whatsappOptInAt = new Date(); // keep the first consent time
        } else {
          set.whatsappOptInAt = null;
        }
      }
      if (Object.keys(set).length === 0) {
        // Opting in again when already opted in is a no-op, not an error.
        if (whatsappOptIn === true) set.whatsappOptInAt = sql`${users.whatsappOptInAt}`;
        else return reply.code(400).send({ error: "nothing_to_update" });
      }
      const [user] = await db
        .update(users)
        .set(set)
        .where(eq(users.id, req.userId!))
        .returning({
          id: users.id,
          email: users.email,
          displayName: users.displayName,
          businessName: users.businessName,
          businessCategory: users.businessCategory,
          phone: users.phone,
          whatsappOptInAt: users.whatsappOptInAt,
          role: users.role,
          isInternal: users.isInternal,
        });
      const { whatsappOptInAt, isInternal, ...rest } = user!;
      return {
        ...rest,
        whatsapp: await whatsAppStateFor({ id: user!.id, phone: user!.phone, whatsappOptInAt, isInternal }),
      };
    },
  );

  // Admin "Test as customer" (lib/testMode). Only an admin may switch it on
  // (403 for anyone else); the REAL role is read from the database, not the
  // JWT, so a just-demoted admin cannot. Admin pages keep working while it is
  // on, so the admin can always switch back.
  app.patch(
    "/auth/me/test-mode",
    { preHandler: requireAuth, schema: { body: z.object({ on: z.boolean() }) } },
    async (req, reply) => {
      const { on } = req.body as { on: boolean };
      const [me] = await db.select({ role: users.role }).from(users).where(eq(users.id, req.userId!)).limit(1);
      if (!me || !mayToggleTestMode(me.role)) return reply.code(403).send({ error: "admin_role_required" });
      const [user] = await db
        .update(users)
        .set({ testAsCustomer: on })
        .where(eq(users.id, req.userId!))
        .returning({ testAsCustomer: users.testAsCustomer });
      req.log.info({ userId: req.userId, on }, "admin test-as-customer toggled");
      return { testAsCustomer: user!.testAsCustomer };
    },
  );

  app.delete("/auth/sessions", { preHandler: requireAuth }, async (req, reply) => {
    await db.delete(sessions).where(eq(sessions.userId, req.userId!));
    return reply.code(204).send();
  });

  // ---- account deletion (api/ROUTES.md "Account deletion") ----

  app.get("/auth/me/deletion", { preHandler: requireAuth }, async (req) => deletionPreview(req.userId!));

  app.post(
    "/auth/me/delete",
    { preHandler: requireAuth, schema: { body: z.object({ password: z.string().min(1).max(200) }) } },
    async (req, reply) => {
      const userId = req.userId!;
      const [user] = await db
        .select({ passwordHash: users.passwordHash, deletedAt: users.deletedAt })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (!user || user.deletedAt) return reply.code(401).send({ error: "account_deleted" });
      if (!(await verifySecret((req.body as { password: string }).password, user.passwordHash))) {
        return reply.code(403).send({ error: "wrong_password" });
      }
      const res = await deleteAccount(userId);
      if (!res.ok) return reply.code(401).send({ error: "account_deleted" });
      req.log.info({ userId }, "account deleted");
      return reply.code(204).send();
    },
  );
}

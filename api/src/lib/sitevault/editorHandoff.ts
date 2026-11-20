// "Your website" (2026-11-19): AdVault shows SiteVault's own editor in an
// iframe on /dashboard/website, so customers edit their AdVault-made website
// without leaving AdVault and without a second sign-in.
//
// The frame opens SiteVault `GET /embed/session?token=…` with a short-lived,
// single-use, signed handoff. SiteVault (web/src/embed.ts) checks the
// signature, the lifetime, single use (KV jti) and that this AdVault user's
// account owns the AdVault-made site, then sets its normal session cookie and
// redirects to the embed editor (`/edit/<slug>?embed=1`).
//
//   token   = <payload>.<sig>
//   payload = base64url(JSON { v: 1, uid, email, slug, iat, exp, jti })
//   sig     = base64url(HMAC-SHA256(SITEVAULT_INTERNAL_TOKEN, "sv-embed-v1." + payload))
//
// Same shared secret as the internal API (SiteVault's INTERNAL_TOKEN); the
// "sv-embed-v1." prefix keeps this MAC apart from anything else. No password
// or long-lived secret ever goes in the URL.

import { createHmac, randomBytes } from "node:crypto";
import { SITEVAULT_URL } from "./index.js";

/** SiteVault refuses anything older; 60 s covers the iframe load. */
export const HANDOFF_TTL_SECONDS = 60;
const PREFIX = "sv-embed-v1.";

export type EditorHandoff = { v: 1; uid: string; email: string; slug: string; iat: number; exp: number; jti: string };

export function signEditorHandoff(secret: string, h: EditorHandoff): string {
  const payload = Buffer.from(JSON.stringify(h)).toString("base64url");
  const sig = createHmac("sha256", secret).update(PREFIX + payload).digest("base64url");
  return `${payload}.${sig}`;
}

/**
 * The iframe URL that signs this AdVault user in to SiteVault's editor for
 * their site. null while SiteVault isn't configured here.
 */
export function editorHandoffUrl(user: { advaultUserId: string; email: string }, slug: string, nowMs = Date.now()): string | null {
  const secret = process.env.SITEVAULT_INTERNAL_TOKEN;
  if (!secret) return null;
  const iat = Math.floor(nowMs / 1000);
  const token = signEditorHandoff(secret, {
    v: 1,
    uid: user.advaultUserId,
    email: user.email,
    slug,
    iat,
    exp: iat + HANDOFF_TTL_SECONDS,
    jti: randomBytes(18).toString("base64url"),
  });
  return `${SITEVAULT_URL}/embed/session?token=${encodeURIComponent(token)}`;
}

// "Make me a website" with SiteVault's FULL builder (2026-11-19): the same
// format and 60 s life, but its own MAC prefix and an explicit purpose, so an
// edit token can never open the create builder and vice versa. It names the
// pre-fill draft (createSitevaultDraft) by id only; SiteVault checks the
// draft is this user's, for this campaign, with the same pay flag.
//
//   payload = base64url(JSON { v: 1, purpose: "create", uid, email, campaignId, draft, pay, iat, exp, jti })
//   sig     = base64url(HMAC-SHA256(SITEVAULT_INTERNAL_TOKEN, "sv-embed-create-v1." + payload))

const CREATE_PREFIX = "sv-embed-create-v1.";

export type CreateHandoff = {
  v: 1;
  purpose: "create";
  uid: string;
  email: string;
  campaignId: string;
  draft: string;
  pay: boolean;
  iat: number;
  exp: number;
  jti: string;
};

export function signCreateHandoff(secret: string, h: CreateHandoff): string {
  const payload = Buffer.from(JSON.stringify(h)).toString("base64url");
  const sig = createHmac("sha256", secret).update(CREATE_PREFIX + payload).digest("base64url");
  return `${payload}.${sig}`;
}

/** The iframe URL of SiteVault's builder in AdVault create mode. null while SiteVault isn't configured. */
export function createHandoffUrl(
  user: { advaultUserId: string; email: string },
  campaignId: string,
  draftId: string,
  pay: boolean,
  nowMs = Date.now(),
): string | null {
  const secret = process.env.SITEVAULT_INTERNAL_TOKEN;
  if (!secret) return null;
  const iat = Math.floor(nowMs / 1000);
  const token = signCreateHandoff(secret, {
    v: 1,
    purpose: "create",
    uid: user.advaultUserId,
    email: user.email,
    campaignId,
    draft: draftId,
    pay,
    iat,
    exp: iat + HANDOFF_TTL_SECONDS,
    jti: randomBytes(18).toString("base64url"),
  });
  return `${SITEVAULT_URL}/embed/new?token=${encodeURIComponent(token)}`;
}

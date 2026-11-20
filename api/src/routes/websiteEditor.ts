// "Your website" (2026-11-19): /dashboard/website shows SiteVault's own
// editor in an iframe, signed in by a 60-second, single-use handoff
// (lib/sitevault/editorHandoff.ts). Customers never see a SiteVault sign-in
// form and never leave AdVault.
//
// The site is ALWAYS the signed-in user's own (SiteVault's account-site
// lookup for req.userId); the client never names a slug, so a user cannot
// mint a handoff for someone else's site. SiteVault re-checks ownership.

import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth/plugin.js";
import { db } from "../db/index.js";
import { users } from "../db/schema.js";
import { fetchAccountSitevaultSite, sitevaultConfigured, sitevaultStateIsLive } from "../lib/sitevault/index.js";
import { editorHandoffUrl } from "../lib/sitevault/editorHandoff.js";

export type WebsiteEditorReply = {
  /** The account's SiteVault website, or null when it has none. */
  site: { slug: string; siteUrl: string; live: boolean; madeHere: boolean } | null;
  /** The iframe URL (single use, 60 s). null = no editor to show (no site, or a site built on SiteVault). */
  editorUrl: string | null;
};

export async function websiteEditorRoutes(app: FastifyInstance) {
  app.addHook("onRequest", requireAuth);

  app.get("/website/editor", async (req, reply): Promise<WebsiteEditorReply> => {
    // A handoff URL signs the user in on SiteVault: never cache it.
    reply.header("cache-control", "no-store");
    if (!sitevaultConfigured()) return { site: null, editorUrl: null };
    const userId = req.userId!;
    const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
    if (!u) return { site: null, editorUrl: null };
    const found = await fetchAccountSitevaultSite({ advaultUserId: userId, email: u.email });
    if (!found) return { site: null, editorUrl: null };
    // Only AdVault-made sites are edited here (AdVault covers their website,
    // so the embedded editor hides SiteVault billing). A site built on
    // SiteVault keeps its own editor and billing there.
    const madeHere = found.source === "advault";
    return {
      site: { slug: found.slug, siteUrl: found.siteUrl, live: sitevaultStateIsLive(found.state), madeHere },
      editorUrl: madeHere ? editorHandoffUrl({ advaultUserId: userId, email: u.email }, found.slug) : null,
    };
  });
}

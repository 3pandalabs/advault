"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  createWebsite,
  deleteAccountWebsite,
  getWebsite,
  updateCampaign,
  linkExistingWebsite,
  startWebsiteBuilder,
  websiteBuilderCreated,
  websiteCheckout,
  websiteReady,
  type Campaign,
  type PendingSite,
  type SiteLinkState,
} from "@/lib/api/browser";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SITEVAULT_ACCOUNT_URL, siteVaultSlug } from "@/lib/sitevault";
import { SuggestionChips } from "@/components/SuggestionChips";
import { openingHoursSuggestions, townFromAddress } from "@/lib/suggestions";
import { EditOnSiteVault, SiteEditorFrame, useSiteEditor, type CreatedSite } from "@/components/SiteEditorFrame";

// "Your website" on the campaign page. A website is OPTIONAL to make ads
// (since 2026-11-15) but Google needs a link to launch (landing_url_required).
// A campaign without one can paste its link, or press "Make me a website":
// AdVault builds a one-page SiteVault site from the campaign (name, category,
// offer, the ad's polished photos) plus phone and town, and uses it as the
// ad's link (POST /campaigns/:id/website). Editable until launch.
//
// "Make me a website" (2026-11-19) shows SiteVault's FULL builder inline
// (every option: style, services, menu, hours, FAQ, team, photos…), pre-filled
// from the campaign, BEFORE the site exists: POST /campaigns/:id/website/builder
// stores the pre-fill on SiteVault and returns a one-time frame link. When
// SiteVault says sitevault:created, the API verifies it with SiteVault and
// records it (link, or the $10 checkout). The short form stays only as a
// fallback ("Use the quick form instead", and automatically when the builder
// can't open: an older SiteVault, or a test customer with no real email).
//
// Right after a quick-form site is made (2026-11-19, "Option A") SiteVault's FULL editor opens
// inline below, scrolled to "Website style", with a "Skip for now". A paid
// site ($10 fee) opens it only once the payment has published it: checkout
// returns to this page with ?website=paid, the card waits for the site to go
// live, then opens the editor. "Edit my website" opens the same editor.

// SiteVault's public address check (CORS open): availability + suggestions.
const SITEVAULT_URL = "https://sitevault.3pandalabs.com";
const SITES_DOMAIN = "3pandasite.com";
type AddressCheck = { address: string; available: boolean; problem: string | null; suggestions: string[] };

async function checkAddress(params: { slug?: string; name: string; city: string }): Promise<AddressCheck | null> {
  const q = new URLSearchParams({ slug: params.slug ?? "", name: params.name, city: params.city });
  try {
    const res = await fetch(`${SITEVAULT_URL}/api/address?${q}`);
    return res.ok ? ((await res.json()) as AddressCheck) : null;
  } catch {
    return null;
  }
}

const MAKE_ERRORS: Record<string, string> = {
  website_exists: "This campaign already has a website.",
  website_exists_for_account: "Your business already has a website. Use it for this campaign instead.",
  account_website_not_live: "Your website isn't published yet. Publish it on SiteVault first, then use it here.",
  no_account_website: "We couldn't find your website just now. Please try again in a minute.",
  website_payment_pending: "Your website is built and waiting for payment. Use Pay and publish below.",
  campaign_is_live: "This campaign is live, so its website can't be changed here.",
  website_builder_not_configured: "The website builder isn't switched on yet. Please paste a link instead.",
  website_builder_failed: "We couldn't build the website just now. Please try again in a minute.",
};

// Admin "Delete it and make a new one".
const DELETE_ERRORS: Record<string, string> = {
  account_website_changed: "Your website changed meanwhile. Reload the page and try again.",
  website_in_use_by_launched_campaign: "A launched campaign uses this website, so it can't be deleted.",
  website_has_subscription: "This website has a SiteVault subscription. Cancel it first, then delete.",
  website_not_your_site: "This website belongs to another account.",
  no_account_website: "There's no website to delete any more. Reload the page.",
  campaign_is_live: MAKE_ERRORS.campaign_is_live!,
  admin_role_required: "Only admins can delete a website.",
};

type SiteOfferState = { outcome: "updated" | "pending" | "retrying" | "failed"; offer: string | null };

const SITE_OFFER_TEXT: Record<SiteOfferState["outcome"], string> = {
  updated: "updated",
  pending: "pending",
  retrying: "couldn't update — we'll retry",
  failed: "couldn't update. You can change it on your website's edit page",
};

export function WebsiteCard({
  campaign,
  onSaved,
  siteOfferRev = 0,
  ownVideoOnly = false,
}: {
  campaign: Campaign;
  onSaved: (c: Campaign) => void;
  /** The campaign's only ads are the owner's own videos: theirs goes on the site when it's made. */
  ownVideoOnly?: boolean;
  /** Bumped by the campaign page after a website offer is bought or pushed. */
  siteOfferRev?: number;
}) {
  const locked = campaign.status === "live" || Boolean(campaign.googleCampaignResourceName);
  // A SiteVault link is checked until it loads (gives up after ~3 minutes).
  // Just made or paid for here: a "building your website" bar meanwhile. Any
  // other link (pasted, or made earlier): the link, and why it isn't live.
  const isSiteVault = Boolean(siteVaultSlug(campaign.landingUrl));
  const [siteReady, setSiteReady] = useState<boolean>(!isSiteVault);
  const [linkState, setLinkState] = useState<SiteLinkState | null>(null);
  const [checkRev, setCheckRev] = useState(0);
  const [madeHere, setMadeHere] = useState(false);
  const [checkStartedAt] = useState(() => Date.now());
  useEffect(() => {
    if (!isSiteVault) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resets the check when the link stops being SiteVault
      setSiteReady(true);
      return;
    }
    let cancelled = false;
    let tries = 0;
    const check = () =>
      websiteReady(campaign.id)
        .catch((): Awaited<ReturnType<typeof websiteReady>> => ({ ready: false }))
        .then(({ ready, state }) => {
          if (cancelled) return;
          setLinkState(state ?? (ready ? "live" : "unknown"));
          tries += 1;
          if (ready || tries >= 45) setSiteReady(true);
          else setTimeout(check, 4000);
        });
    setSiteReady(false);
    setLinkState(null);
    void check();
    return () => {
      cancelled = true;
    };
  }, [campaign.id, campaign.landingUrl, isSiteVault, checkRev]);
  // "make" = SiteVault's full builder inline; "quick" = the short fallback form.
  const [mode, setMode] = useState<"view" | "link" | "make" | "quick">("view");
  const [draft, setDraft] = useState(campaign.landingUrl ?? "");
  const [phone, setPhone] = useState("");
  const [city, setCity] = useState(campaign.targetAddress?.city ?? "");
  const town = townFromAddress(campaign.targetAddress);
  const [hours, setHours] = useState("");
  const [attest, setAttest] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editUrl, setEditUrl] = useState<string | null>(null);
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [address, setAddress] = useState<AddressCheck | null>(null);
  const fetchedWebsite = useRef(false);
  const [accountSite, setAccountSite] = useState<string | null>(null);
  // "pending" = made on another campaign and waiting for payment (admins see it to delete it).
  const [accountSiteState, setAccountSiteState] = useState<string | null>(null);
  // REAL admins (also in "Test as customer"): delete the site and make a new one.
  const [adminCanDelete, setAdminCanDelete] = useState(false);
  const [adminCanMakeAnother, setAdminCanMakeAnother] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // After an admin delete: which site went (the card may then show another one).
  const [deletedSite, setDeletedSite] = useState<string | null>(null);
  const [siteOffer, setSiteOffer] = useState<SiteOfferState | null>(null);
  // $10 website fee: the made-but-unpaid site, and the price ("$10"; null = free).
  const [pendingSite, setPendingSite] = useState<PendingSite | null>(null);
  const [websiteFee, setWebsiteFee] = useState<string | null | undefined>(undefined);
  // The inline SiteVault editor: "welcome" right after the site is made (or
  // paid for), "edit" from the Edit my website button, "closed" once dismissed.
  const [editorOpen, setEditorOpen] = useState<"welcome" | "edit" | "closed" | null>(null);
  // Back from the $10 checkout (?website=paid): open the editor once the site is live.
  const [returnedFromPay] = useState(
    () => typeof window !== "undefined" && new URLSearchParams(window.location.search).get("website") === "paid",
  );
  const paidWelcome = returnedFromPay && isSiteVault && Boolean(campaign.landingUrl) && !pendingSite;
  const building = Boolean(campaign.landingUrl) && !siteReady && (madeHere || returnedFromPay);
  const editorView = editorOpen === "closed" ? null : (editorOpen ?? (paidWelcome ? "welcome" : null));
  useEffect(() => {
    if (!paidWelcome) return;
    // Once only: a later refresh shouldn't reopen the welcome.
    const url = new URL(window.location.href);
    url.searchParams.delete("website");
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
  }, [paidWelcome]);
  // Offer combo: did the latest website offer reach the site? Re-checked a
  // few times while SiteVault hasn't confirmed it yet (the push follows payment).
  useEffect(() => {
    if (!isSiteVault) return;
    let cancelled = false;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () =>
      getWebsite(campaign.id)
        .then((w) => {
          if (cancelled) return;
          setSiteOffer(w.siteOffer ?? null);
          if (w.siteOffer?.outcome === "pending" && tries++ < 6) timer = setTimeout(load, 5000);
        })
        .catch(() => {});
    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [campaign.id, isSiteVault, siteOfferRev]);

  // The SiteVault edit link is stored encrypted; fetch it only when there is
  // one. The same call follows a rename made on SiteVault (link updated).
  useEffect(() => {
    // Also when there is no website yet: the account may already have one.
    // A SiteVault link without a stored edit link (built on SiteVault, linked
    // with "Use my website") still gets one: SiteVault's sign-in edit page.
    if ((!campaign.sitevaultEditEnc && campaign.landingUrl && !siteVaultSlug(campaign.landingUrl)) || editUrl || fetchedWebsite.current) return;
    fetchedWebsite.current = true;
    getWebsite(campaign.id)
      .then((w) => {
        setEditUrl(w.editUrl);
        applyAccountSite(w);
        setPendingSite(w.pendingSite ?? null);
        setWebsiteFee(w.websiteFee);
        if (w.campaign) onSaved(w.campaign);
      })
      .catch(() => {});
  }, [campaign.id, campaign.sitevaultEditEnc, campaign.landingUrl, editUrl, onSaved]);

  // Paid, waiting for SiteVault to publish (seconds): re-check until the link
  // appears. Also straight after checkout, before the payment webhook landed.
  const awaitingPublish = Boolean(pendingSite && (pendingSite.paid || returnedFromPay));
  useEffect(() => {
    if (!awaitingPublish) return;
    let tries = 0;
    const timer = setInterval(() => {
      getWebsite(campaign.id)
        .then((w) => {
          if (w.pendingSite) setPendingSite(w.pendingSite);
          else {
            setPendingSite(null);
            clearInterval(timer);
            window.location.reload(); // pick up the new link on the campaign (keeps ?website=paid)
          }
        })
        .catch(() => {});
      if (++tries > 12) clearInterval(timer);
    }, 5000);
    return () => clearInterval(timer);
  }, [campaign.id, awaitingPublish, pendingSite?.paid]);

  async function payForWebsite() {
    setBusy(true);
    setError(null);
    try {
      const { checkout } = await websiteCheckout(campaign.id);
      if (checkout.redirectUrl) window.location.assign(checkout.redirectUrl);
    } catch (err) {
      setError(err instanceof ApiError && err.code === "website_already_paid" ? "Payment received. Publishing your website…" : "Could not start the payment. Please try again.");
      setBusy(false);
    }
  }

  // Address: suggested from the business name (and town) until they type
  // their own, then checked as they type.
  useEffect(() => {
    if (mode !== "quick") return;
    const t = setTimeout(() => {
      checkAddress({ slug: slugTouched ? slug : "", name: campaign.businessName, city }).then((res) => {
        if (!res) return;
        setAddress(res);
        if (!slugTouched && res.address) setSlug(res.address);
      });
    }, 350);
    return () => clearTimeout(t);
  }, [mode, slug, slugTouched, city, campaign.businessName]);

  const linkValid = draft.trim() === "" || /^https?:\/\/\S+\.\S+/i.test(draft.trim());
  const makeValid =
    phone.replace(/\D/g, "").length >= 7 && city.trim().length >= 2 && attest && (address?.available ?? true);

  async function saveLink() {
    setBusy(true);
    setError(null);
    try {
      const saved = await updateCampaign(campaign.id, { landingUrl: draft.trim() || null });
      setMadeHere(false);
      onSaved(saved);
      setMode("view");
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === "campaign_is_live"
          ? MAKE_ERRORS.campaign_is_live!
          : "Could not save. Check the link starts with https:// and try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function linkExisting() {
    setBusy(true);
    setError(null);
    try {
      const res = await linkExistingWebsite(campaign.id);
      fetchedWebsite.current = false;
      setAccountSite(null);
      onSaved(res.campaign);
    } catch (err) {
      setError(err instanceof ApiError ? (MAKE_ERRORS[err.code] ?? "Could not use your website. Please try again.") : "Could not use your website. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  function applyAccountSite(w: Awaited<ReturnType<typeof getWebsite>>) {
    setAccountSite(w.accountSite?.siteUrl ?? null);
    setAccountSiteState(w.accountSite?.state ?? null);
    setAdminCanDelete(Boolean(w.adminCanDelete));
    setAdminCanMakeAnother(Boolean(w.adminCanMakeAnother));
  }

  // Admin: delete the account's website for good, then the full "Make me a
  // website" form, exactly as for a brand-new one (the price, if any, is re-read).
  async function deleteAndMakeNew() {
    if (!accountSite) return;
    const deleting = accountSite;
    setBusy(true);
    setError(null);
    try {
      await deleteAccountWebsite(campaign.id, deleting);
      setConfirmDelete(false);
      setDeletedSite(deleting);
      const w = await getWebsite(campaign.id);
      applyAccountSite(w);
      setPendingSite(w.pendingSite ?? null);
      setWebsiteFee(w.websiteFee);
      // Another older site may still be on the account: then the card shows that one.
      if (!w.accountSite) setMode("make");
    } catch (err) {
      setError(
        err instanceof ApiError
          ? (DELETE_ERRORS[err.code] ?? "Could not delete the website. Please try again.")
          : "Could not delete the website. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function make() {
    setBusy(true);
    setError(null);
    try {
      const res = await createWebsite(campaign.id, {
        phone: phone.trim(),
        city: city.trim(),
        hours: hours.trim() || undefined,
        slug: slug.trim() || undefined,
        attest: true,
      });
      setEditUrl(res.editUrl);
      setMadeHere(true);
      onSaved(res.campaign);
      setMode("view");
      if (res.pendingSite) {
        setPendingSite(res.pendingSite);
        // Straight to the $10 checkout; the card offers "Pay and publish" if this fails.
        // The editor opens after payment (?website=paid), never before.
        if (res.checkout?.redirectUrl) window.location.assign(res.checkout.redirectUrl);
      } else {
        setEditorOpen("welcome");
      }
    } catch (err) {
      setError(
        err instanceof ApiError
          ? (err.code === "website_invalid" && err.detail
              ? `SiteVault says: ${err.detail}`
              : MAKE_ERRORS[err.code] ?? "Could not build the website. Please try again.")
          : "Could not build the website. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mb-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <CardTitle>Your website</CardTitle>
          <CardDescription>
            {building ? (
              <WebsiteBuilding startedAt={checkStartedAt} />
            ) : campaign.landingUrl ? (
              <a href={campaign.landingUrl} target="_blank" rel="noreferrer" className="break-all hover:underline">
                {campaign.landingUrl}
              </a>
            ) : (
              <>
                YouTube needs a website link for your business before the ad goes live.
                {!locked && (
                  <span className="mt-2 block text-zinc-300">
                    No website yet? Don&apos;t worry, we&apos;ve got you covered. We can make you one in minutes, with
                    no hassle and at almost no cost: your photos, offer and ad video, with call and directions buttons.
                    {websiteFee
                      ? ` ${websiteFee} once; Pro (visitor stats) stays included while your AdVault plan runs.`
                      : ""}
                  </span>
                )}
              </>
            )}
          </CardDescription>
        </div>
        {!locked && mode === "view" && campaign.landingUrl && (
          <Button size="sm" variant="ghost" onClick={() => setMode("link")}>
            Change
          </Button>
        )}
      </div>

      {error && <p className="mt-3 text-sm text-red-300">{error}</p>}

      {campaign.landingUrl && isSiteVault && mode === "view" && !building && (
        <SiteLinkNotice state={linkState} onCheck={() => setCheckRev((n) => n + 1)} />
      )}

      {editUrl && campaign.landingUrl && siteReady && mode === "view" && !editorView && (
        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
          <Button size="sm" onClick={() => setEditorOpen("edit")}>
            Edit my website
          </Button>
          <p className="text-sm text-zinc-400">Add services, prices, hours, photos or change the style.</p>
        </div>
      )}

      {editorView && campaign.landingUrl && mode === "view" && (
        <div className="mt-4 space-y-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <p className="text-sm text-zinc-200">
              {editorView === "welcome"
                ? "Your website is ready. Make it yours: pick a style, add your menu, hours, services and more."
                : "Edit your website. Press Save changes when you’re done."}
            </p>
            <button
              type="button"
              onClick={() => setEditorOpen("closed")}
              className="shrink-0 text-sm text-zinc-400 underline underline-offset-4 hover:text-zinc-200"
            >
              {editorView === "welcome" ? "Skip for now" : "Close editor"}
            </button>
          </div>
          {siteReady ? (
            <InlineSiteEditor focus={editorView === "welcome" ? "style" : undefined} />
          ) : (
            <p className="text-sm text-zinc-400">The editor opens here as soon as your website is live.</p>
          )}
        </div>
      )}

      {siteVaultSlug(campaign.landingUrl) && campaign.sitevaultEditEnc && mode === "view" && !ownVideoOnly && (campaign.siteVideoPushedAt || campaign.siteVideoWanted || !locked) && (
        <p className="mt-3 text-sm text-zinc-300">
          {campaign.siteVideoPushedAt
            ? "Your ad is playing on your website."
            : campaign.siteVideoWanted
              ? "Adding your ad to your website…"
              : "Launch your ad and it plays on your website too."}
        </p>
      )}

      {campaign.landingUrl && !(isSiteVault && campaign.sitevaultEditEnc) && mode === "view" && (
        <p className="mt-3 text-sm text-zinc-400">
          We can’t post your ad video on this website. We can only do that for websites made with AdVault.
        </p>
      )}

      {siteOffer && campaign.landingUrl && mode === "view" && (
        <p className={`mt-3 text-sm ${siteOffer.outcome === "updated" ? "text-emerald-300" : siteOffer.outcome === "pending" ? "text-zinc-300" : "text-amber-300"}`}>
          Offer on your website: {SITE_OFFER_TEXT[siteOffer.outcome]}
          {siteOffer.offer ? <span className="block break-words text-zinc-400">“{siteOffer.offer}”</span> : null}
        </p>
      )}

      {!campaign.landingUrl && mode === "view" && pendingSite && (
        <div className="mt-4 space-y-2">
          <p className="text-sm text-zinc-300">
            Your website is built:{" "}
            <span className="break-all text-zinc-100">{pendingSite.siteUrl}</span>
          </p>
          {pendingSite.paid ? (
            <p className="text-sm text-emerald-300">Payment received. Publishing your website…</p>
          ) : (
            <>
              <p className="text-sm text-zinc-300">
                Publish it for {pendingSite.display ?? "$10"} once; Pro (visitor stats) stays included while your
                AdVault plan runs.
              </p>
              <Button onClick={payForWebsite} disabled={busy}>
                {busy ? "Opening payment…" : `Pay ${pendingSite.display ?? "$10"} and publish`}
              </Button>
            </>
          )}
          {editUrl && (
            <p className="text-sm text-zinc-400">
              <a href="/dashboard/website" className="text-amber-300 underline">
                Preview and edit your website
              </a>
            </p>
          )}
        </div>
      )}

      {!locked && !campaign.landingUrl && mode === "view" && !pendingSite && accountSite && (
        <div className="mt-4 space-y-2">
          {deletedSite && deletedSite !== accountSite && (
            <p className="text-sm text-emerald-300" role="status">
              Deleted {deletedSite}. Your account has another website, shown below. Delete it too to make a new one.
            </p>
          )}
          <p className="text-sm text-zinc-300">
            {accountSiteState === "pending" ? "Your business already has a website, waiting for payment on another campaign: " : "Your business already has a website: "}
            <a href={accountSite} target="_blank" rel="noreferrer" className="break-all text-amber-300 underline">
              {accountSite}
            </a>
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            {accountSiteState !== "pending" && (
              <Button onClick={linkExisting} disabled={busy}>
                {busy ? "Saving…" : "Use my website"}
              </Button>
            )}
            <Button variant="outline" onClick={() => setMode("link")} disabled={busy}>
              Use a different website
            </Button>
          </div>
          {adminCanDelete && !confirmDelete && (
            <div className="rounded-lg border border-white/10 bg-white/5 p-3 text-sm text-zinc-300">
              <p>
                <span className="font-medium text-zinc-100">Admin:</span> as an admin you can delete this website and
                make a new one.
              </p>
              <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                <Button size="sm" variant="outline" onClick={() => setConfirmDelete(true)} disabled={busy}>
                  Delete it and make a new one
                </Button>
                {adminCanMakeAnother && (
                  <Button size="sm" variant="ghost" onClick={() => setMode("make")} disabled={busy}>
                    Keep it and make another
                  </Button>
                )}
              </div>
            </div>
          )}
          {adminCanDelete && confirmDelete && (
            <div className="rounded-lg border border-red-400/40 bg-red-500/10 p-3 text-sm text-zinc-200" role="alert">
              <p className="font-medium text-red-200">Delete {accountSite} for good?</p>
              <p className="mt-1">
                The website goes offline for good: its page, photos, video and before &amp; after photos are deleted,
                and any campaign not yet launched that uses it loses its link. This can&apos;t be undone. Then you can
                make a new website.
              </p>
              <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                <Button size="sm" onClick={deleteAndMakeNew} disabled={busy}>
                  {busy ? "Deleting…" : "Yes, delete it for good"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)} disabled={busy}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {!locked && !campaign.landingUrl && mode === "view" && !accountSite && !pendingSite && (
        <div className="mt-4 flex flex-col gap-2 sm:flex-row">
          <Button onClick={() => setMode("make")}>
            {websiteFee ? `Make me a website, ${websiteFee}` : "Make me a website"}
          </Button>
          <Button variant="outline" onClick={() => setMode("link")}>
            I have a website
          </Button>
        </div>
      )}

      {mode === "link" && (
        <div className="mt-4 flex flex-col gap-2 sm:flex-row">
          <div className="min-w-0 flex-1">
            <Input
              id="website-link"
              type="url"
              placeholder="https://mikesplumbing.com"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              disabled={busy}
              aria-label="Website link"
            />
            <SuggestionChips
              targetId="website-link"
              fieldLabel="website link"
              value={draft}
              suggestions={[campaign.landingUrl, accountSite]}
              onPick={setDraft}
              disabled={busy}
            />
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={saveLink} disabled={busy || !linkValid}>
              {busy ? "Saving…" : "Save"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setMode("view")} disabled={busy}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {mode === "make" && (
        <div className="mt-4 space-y-3">
          {deletedSite && (
            <p className="text-sm text-emerald-300" role="status">
              Deleted {deletedSite}. Now make the new website.
            </p>
          )}
          <EmbeddedBuilder
            campaignId={campaign.id}
            websiteFee={websiteFee}
            onRecorded={(res) => {
              setEditUrl(res.editUrl);
              setMadeHere(true);
              onSaved(res.campaign);
              setMode("view");
              if (res.pendingSite) {
                setPendingSite(res.pendingSite);
                // Straight to the $10 checkout; the card offers "Pay and publish" if this fails.
                if (res.checkout?.redirectUrl) window.location.assign(res.checkout.redirectUrl);
              }
            }}
            onQuickForm={() => setMode("quick")}
            onCancel={() => setMode("view")}
          />
        </div>
      )}

      {mode === "quick" && (
        <div className="mt-4 space-y-3">
          {deletedSite && (
            <p className="text-sm text-emerald-300" role="status">
              Deleted {deletedSite}. Now make the new website.
            </p>
          )}
          <p className="text-sm text-zinc-300">
            We&apos;ll build a one-page website from this campaign: your business name, your offer
            and your ad photos, with call and text buttons.
            {websiteFee ? ` It's ${websiteFee} once; Pro (visitor stats) stays included while your AdVault plan runs.` : ""}{" "}
            We just need two things:
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm">
              <span className="mb-1 block text-zinc-300">Business phone</span>
              <Input
                type="tel"
                autoComplete="tel"
                placeholder="(201) 555-0100"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                disabled={busy}
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-zinc-300">Town or city</span>
              <Input id="website-city" placeholder="Secaucus, NJ" value={city} onChange={(e) => setCity(e.target.value)} disabled={busy} />
              <SuggestionChips
                targetId="website-city"
                fieldLabel="town or city"
                value={city}
                suggestions={[town]}
                onPick={setCity}
                disabled={busy}
              />
            </label>
          </div>
          <div className="text-sm">
            <label htmlFor="site-address" className="mb-1 block text-zinc-300">
              Your web address
            </label>
            <div className="flex items-center overflow-hidden rounded-lg border border-white/15 bg-white/5 focus-within:ring-2 focus-within:ring-amber-400">
              <span className="pl-3 text-zinc-500">https://</span>
              <input
                id="site-address"
                className="min-w-0 flex-1 bg-transparent px-0.5 py-2 text-zinc-100 outline-none"
                autoCapitalize="none"
                autoComplete="off"
                spellCheck={false}
                maxLength={40}
                value={slug}
                onChange={(e) => {
                  setSlugTouched(true);
                  setSlug(e.target.value.toLowerCase());
                }}
                disabled={busy}
              />
              <span className="pr-3 text-zinc-500">.{SITES_DOMAIN}</span>
            </div>
            <p className="mt-1 text-xs" aria-live="polite">
              {address &&
                (address.available ? (
                  <span className="text-emerald-300">✓ {address.address}.{SITES_DOMAIN} is available</span>
                ) : (
                  <span className="text-red-300">
                    {address.problem}
                    {address.suggestions.length > 0 && " Try: "}
                    {address.suggestions.map((s) => (
                      <button
                        key={s}
                        type="button"
                        className="mr-1 rounded-full border border-white/15 px-2 py-0.5 text-zinc-200 hover:bg-white/10"
                        onClick={() => {
                          setSlugTouched(true);
                          setSlug(s);
                        }}
                      >
                        {s}
                      </button>
                    ))}
                  </span>
                ))}
            </p>
          </div>
          <label className="block text-sm">
            <span className="mb-1 block text-zinc-300">Opening hours (optional)</span>
            <Input
              id="website-hours"
              placeholder="Mon-Fri 8am-6pm, Sat 9am-2pm"
              value={hours}
              onChange={(e) => setHours(e.target.value)}
              disabled={busy}
            />
            <SuggestionChips
              targetId="website-hours"
              fieldLabel="opening hours"
              value={hours}
              suggestions={openingHoursSuggestions(campaign.businessCategory)}
              onPick={setHours}
              disabled={busy}
            />
          </label>
          <label className="flex items-start gap-2 text-sm text-zinc-300">
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 accent-amber-400"
              checked={attest}
              onChange={(e) => setAttest(e.target.checked)}
              disabled={busy}
            />
            <span>
              I run this business, the details are accurate, and I agree to the{" "}
              <a href="https://sitevault.3pandalabs.com/terms" target="_blank" rel="noreferrer" className="underline">
                SiteVault terms
              </a>
              . The website is public.
            </span>
          </label>
          <div className="flex gap-2">
            <Button onClick={make} disabled={busy || !makeValid}>
              {busy ? "Building your website…" : websiteFee ? `Create my website and pay ${websiteFee}` : "Create my website"}
            </Button>
            <Button variant="ghost" onClick={() => setMode("view")} disabled={busy}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

/** SiteVault's full editor under the card (the same frame as /dashboard/website). */
function InlineSiteEditor({ focus }: { focus?: "style" }) {
  const { site, editorUrl, state, reload } = useSiteEditor();
  if (state === "loading") return <p className="text-sm text-zinc-500">Opening the editor…</p>;
  if (state === "error" || !site) {
    return (
      <p className="text-sm text-zinc-400">
        We couldn&apos;t open the editor just now.{" "}
        <button type="button" onClick={reload} className="text-amber-300 underline underline-offset-4">
          Try again
        </button>{" "}
        or open{" "}
        <a href="/dashboard/website" className="text-amber-300 underline underline-offset-4">
          Your website
        </a>
        .
      </p>
    );
  }
  if (!editorUrl) {
    return (
      <p className="text-sm text-zinc-400">
        <EditOnSiteVault slug={site.slug} />
      </p>
    );
  }
  return <SiteEditorFrame editorUrl={editorUrl} onReload={reload} focus={focus} />;
}

const LINK_PROBLEM: Partial<Record<SiteLinkState, string>> = {
  unpublished: "This website isn't published yet, so visitors can't see it. Publish it on SiteVault, then check again.",
  paused: "This website is paused, so visitors can't see it. Renew it on SiteVault, then check again.",
  not_found: "We couldn't find a website at this link. Press Change to fix it.",
  loading: "This website isn't loading yet. It may need another minute.",
  unknown: "We couldn't check this website just now.",
};

/** Why a SiteVault link isn't live. Nothing once it is. */
function SiteLinkNotice({ state, onCheck }: { state: SiteLinkState | null; onCheck: () => void }) {
  if (state === "live") return null;
  if (state === null) return <p className="mt-3 text-sm text-zinc-400" role="status">Checking your website…</p>;
  return (
    <div className="mt-3 space-y-2" role="status">
      <p className="text-sm text-amber-300">{LINK_PROBLEM[state]}</p>
      <div className="flex flex-wrap items-center gap-3">
        {(state === "unpublished" || state === "paused") && (
          <a
            href={SITEVAULT_ACCOUNT_URL}
            target="_blank"
            rel="noreferrer"
            className="rounded-lg border border-white/15 px-3 py-1.5 text-sm text-zinc-200 hover:bg-white/5"
          >
            Open SiteVault
          </a>
        )}
        <Button size="sm" variant="ghost" onClick={onCheck}>
          Check again
        </Button>
      </div>
    </div>
  );
}

/** Shown until the new website actually loads: an estimate, never 100% on its own. */
function WebsiteBuilding({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const fraction = Math.min(0.92, (now - startedAt) / 1000 / 40);
  return (
    <span className="mt-1 block" role="status" aria-live="polite">
      <span className="block text-sm text-zinc-200">Building your website…</span>
      <span className="mt-2 block h-2 w-full max-w-sm overflow-hidden rounded-full bg-white/10">
        <span
          className="block h-full rounded-full bg-amber-400 transition-[width] duration-1000 ease-linear"
          style={{ width: `${Math.round(fraction * 100)}%` }}
        />
      </span>
      <span className="mt-1 block text-xs text-zinc-500">Usually under a minute. The link appears here when it&apos;s live.</span>
    </span>
  );
}

type BuilderResult = Awaited<ReturnType<typeof websiteBuilderCreated>>;

/**
 * SiteVault's full builder for "Make me a website", pre-filled from the
 * campaign. Asks the API for a one-time frame link (which stores the pre-fill
 * on SiteVault), shows it, and on `sitevault:created` has the API verify and
 * record the site. Falls back to the quick form when the builder can't open.
 */
function EmbeddedBuilder({
  campaignId,
  websiteFee,
  onRecorded,
  onQuickForm,
  onCancel,
}: {
  campaignId: string;
  websiteFee: string | null | undefined;
  onRecorded: (res: BuilderResult) => void;
  onQuickForm: () => void;
  onCancel: () => void;
}) {
  const [frame, setFrame] = useState<{ url: string; draftId: string } | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "recording" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedSite | null>(null);
  const [fee, setFee] = useState<string | null | undefined>(websiteFee);
  const onQuickFormRef = useRef(onQuickForm);
  useEffect(() => {
    onQuickFormRef.current = onQuickForm;
  });

  // Each attempt mints a fresh one-time link (and draft); "Try again" / "Reload it" bump it.
  const [attempt, setAttempt] = useState(0);
  const open = useCallback(() => {
    setState("loading");
    setError(null);
    setAttempt((a) => a + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    startWebsiteBuilder(campaignId)
      .then((r) => {
        if (cancelled) return;
        setFrame({ url: r.builderUrl, draftId: r.draftId });
        setFee(r.websiteFee);
        setState("ready");
      })
      .catch((err) => {
        if (cancelled) return;
        // The builder can't open here (older SiteVault, a test customer, SiteVault down): the quick form.
        if (!(err instanceof ApiError) || err.code === "website_builder_unavailable") {
          onQuickFormRef.current();
          return;
        }
        setError(MAKE_ERRORS[err.code] ?? "Could not open the website builder. Please try again.");
        setState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [campaignId, attempt]);

  const record = useCallback(
    (site: CreatedSite) => {
      if (!frame) return;
      // Only the draft this frame was opened with; the API re-checks it with SiteVault.
      if (site.draft && site.draft !== frame.draftId) return;
      setCreated(site);
      setState("recording");
      setError(null);
      websiteBuilderCreated(campaignId, { draftId: frame.draftId, slug: site.slug })
        .then(onRecorded)
        .catch((err) => {
          setError(
            err instanceof ApiError && MAKE_ERRORS[err.code]
              ? MAKE_ERRORS[err.code]!
              : "Your website is made, but we couldn't finish setting it up here. Please try again.",
          );
          setState("error");
        });
    },
    [campaignId, frame, onRecorded],
  );

  return (
    <div className="space-y-3">
      <p className="text-sm text-zinc-300">
        Your website, filled in from this campaign. Pick a style, add your services, hours and anything else, then press
        Create my website.
        {fee ? ` ${fee} once; Pro stays included while your AdVault plan runs.` : ""}
      </p>
      {error && (
        <p className="text-sm text-red-300" role="alert">
          {error}{" "}
          {created ? (
            <button type="button" onClick={() => record(created)} className="text-amber-300 underline underline-offset-4">
              Try again
            </button>
          ) : (
            <button type="button" onClick={open} className="text-amber-300 underline underline-offset-4">
              Try again
            </button>
          )}
        </p>
      )}
      {state === "loading" && <p className="text-sm text-zinc-500">Opening the website builder…</p>}
      {state === "recording" && (
        <p className="text-sm text-zinc-300" role="status">
          {created?.pending ? "Website made. Opening payment…" : "Website made. Setting it as your ad's link…"}
        </p>
      )}
      {frame && state !== "loading" && !created && (
        <SiteEditorFrame editorUrl={frame.url} onReload={open} onCreated={record} title="Build your website" />
      )}
      <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
        {!created && (
          <button type="button" onClick={onQuickForm} className="text-zinc-400 underline underline-offset-4 hover:text-zinc-200">
            Use the quick form instead
          </button>
        )}
        {!created && (
          <button type="button" onClick={onCancel} className="text-zinc-400 underline underline-offset-4 hover:text-zinc-200">
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

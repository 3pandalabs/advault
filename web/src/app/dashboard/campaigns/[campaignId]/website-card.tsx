"use client";

import { useEffect, useRef, useState } from "react";
import {
  ApiError,
  createWebsite,
  getWebsite,
  updateCampaign,
  linkExistingWebsite,
  websiteCheckout,
  type Campaign,
  type PendingSite,
} from "@/lib/api/browser";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { siteVaultSlug } from "@/lib/sitevault";

// "Your website" on the campaign page. A website is OPTIONAL to make ads
// (since 2026-11-15) but Google needs a link to launch (landing_url_required).
// A campaign without one can paste its link, or press "Make me a website":
// AdVault builds a one-page SiteVault site from the campaign (name, category,
// offer, the ad's polished photos) plus phone and town, and uses it as the
// ad's link (POST /campaigns/:id/website). Editable until launch.

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
  website_payment_pending: "Your website is built and waiting for payment. Use Pay and publish below.",
  campaign_is_live: "This campaign is live, so its website can't be changed here.",
  website_builder_not_configured: "The website builder isn't switched on yet. Please paste a link instead.",
  website_builder_failed: "We couldn't build the website just now. Please try again in a minute.",
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
}: {
  campaign: Campaign;
  onSaved: (c: Campaign) => void;
  /** Bumped by the campaign page after a website offer is bought or pushed. */
  siteOfferRev?: number;
}) {
  const locked = campaign.status === "live" || Boolean(campaign.googleCampaignResourceName);
  const [mode, setMode] = useState<"view" | "link" | "make">("view");
  const [draft, setDraft] = useState(campaign.landingUrl ?? "");
  const [phone, setPhone] = useState("");
  const [city, setCity] = useState(campaign.targetAddress?.city ?? "");
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
  const [siteOffer, setSiteOffer] = useState<SiteOfferState | null>(null);
  // $10 website fee: the made-but-unpaid site, and the price ("$10"; null = free).
  const [pendingSite, setPendingSite] = useState<PendingSite | null>(null);
  const [websiteFee, setWebsiteFee] = useState<string | null | undefined>(undefined);
  const isSiteVault = siteVaultSlug(campaign.landingUrl) !== null;

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
    if ((!campaign.sitevaultEditEnc && campaign.landingUrl) || editUrl || fetchedWebsite.current) return;
    fetchedWebsite.current = true;
    getWebsite(campaign.id)
      .then((w) => {
        setEditUrl(w.editUrl);
        setAccountSite(w.accountSite?.siteUrl ?? null);
        setPendingSite(w.pendingSite ?? null);
        setWebsiteFee(w.websiteFee);
        if (w.campaign) onSaved(w.campaign);
      })
      .catch(() => {});
  }, [campaign.id, campaign.sitevaultEditEnc, campaign.landingUrl, editUrl, onSaved]);

  // Paid, waiting for SiteVault to publish (seconds): re-check until the link appears.
  useEffect(() => {
    if (!pendingSite?.paid) return;
    let tries = 0;
    const timer = setInterval(() => {
      getWebsite(campaign.id)
        .then((w) => {
          if (w.pendingSite) setPendingSite(w.pendingSite);
          else {
            setPendingSite(null);
            clearInterval(timer);
            window.location.reload(); // pick up the new link on the campaign
          }
        })
        .catch(() => {});
      if (++tries > 12) clearInterval(timer);
    }, 5000);
    return () => clearInterval(timer);
  }, [campaign.id, pendingSite?.paid]);

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
    if (mode !== "make") return;
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
      onSaved(await updateCampaign(campaign.id, { landingUrl: draft.trim() || null }));
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
      onSaved(res.campaign);
      setMode("view");
      if (res.pendingSite) {
        setPendingSite(res.pendingSite);
        // Straight to the $10 checkout; the card offers "Pay and publish" if this fails.
        if (res.checkout?.redirectUrl) window.location.assign(res.checkout.redirectUrl);
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
            {campaign.landingUrl ? (
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
                      ? ` ${websiteFee}, with the first year of Pro (visitor stats) included; then $49 a year, cancel any time.`
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

      {editUrl && campaign.landingUrl && mode === "view" && (
        <p className="mt-3 text-sm text-zinc-300">
          Made with SiteVault.{" "}
          <a href={editUrl} target="_blank" rel="noreferrer" className="text-amber-300 underline">
            Edit your website
          </a>{" "}
          to add services, prices, hours or more photos.
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
                Publish it for {pendingSite.display ?? "$10"}, with the first year of Pro (visitor stats) included. After
                that it&apos;s $49 a year on SiteVault.
              </p>
              <Button onClick={payForWebsite} disabled={busy}>
                {busy ? "Opening payment…" : `Pay ${pendingSite.display ?? "$10"} and publish`}
              </Button>
            </>
          )}
          {editUrl && (
            <p className="text-sm text-zinc-400">
              <a href={editUrl} target="_blank" rel="noreferrer" className="text-amber-300 underline">
                Preview and edit your website
              </a>
            </p>
          )}
        </div>
      )}

      {!locked && !campaign.landingUrl && mode === "view" && !pendingSite && accountSite && (
        <div className="mt-4 space-y-2">
          <p className="text-sm text-zinc-300">
            Your business already has a website:{" "}
            <a href={accountSite} target="_blank" rel="noreferrer" className="break-all text-amber-300 underline">
              {accountSite}
            </a>
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button onClick={linkExisting} disabled={busy}>
              {busy ? "Saving…" : "Use my website"}
            </Button>
            <Button variant="outline" onClick={() => setMode("link")} disabled={busy}>
              Use a different website
            </Button>
          </div>
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
          <Input
            type="url"
            placeholder="https://mikesplumbing.com"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={busy}
            aria-label="Website link"
          />
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
          <p className="text-sm text-zinc-300">
            We&apos;ll build a one-page website from this campaign: your business name, your offer
            and your ad photos, with call and text buttons.
            {websiteFee ? ` It's ${websiteFee}, with the first year of Pro (visitor stats) included; after that, $49 a year on SiteVault.` : ""}{" "}
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
              <Input placeholder="Secaucus, NJ" value={city} onChange={(e) => setCity(e.target.value)} disabled={busy} />
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
              placeholder="Mon-Fri 8am-6pm, Sat 9am-2pm"
              value={hours}
              onChange={(e) => setHours(e.target.value)}
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

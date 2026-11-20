"use client";

import Link from "next/link";
import { EditOnSiteVault, SiteEditorFrame, useSiteEditor } from "@/components/SiteEditorFrame";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

// "Your website" (2026-11-19). SiteVault's own editor, inside AdVault. The
// frame, the one-time sign-in link and the origin-checked messages live in
// components/SiteEditorFrame.tsx (also used on the campaign page's website card).

export default function WebsitePage() {
  const { site, setSite, editorUrl, state, reload } = useSiteEditor();

  if (state === "loading" && !site) {
    return <p className="text-sm text-zinc-500">Loading your website…</p>;
  }

  if (state === "error") {
    return (
      <Card>
        <CardTitle>Your website</CardTitle>
        <CardDescription>We couldn&apos;t open your website just now.</CardDescription>
        <div className="mt-4">
          <Button onClick={reload}>Try again</Button>
        </div>
      </Card>
    );
  }

  if (!site) {
    return (
      <Card>
        <CardTitle>Your website</CardTitle>
        <CardDescription>
          You don&apos;t have a website yet. Open a campaign and choose <strong>Make me a website</strong> on its
          Website card. We build it from your ad.
        </CardDescription>
        <div className="mt-4">
          <Link href="/dashboard">
            <Button>Go to my campaigns</Button>
          </Link>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">Your website</h1>
          <p className="mt-1 break-all text-sm text-zinc-400">
            <a href={site.siteUrl} target="_blank" rel="noreferrer" className="text-amber-300 underline underline-offset-4">
              {site.siteUrl.replace(/^https:\/\//, "").replace(/\/$/, "")}
            </a>
            {!site.live && <span className="ml-2 text-zinc-500">(not published yet)</span>}
          </p>
        </div>
        <a href={site.siteUrl} target="_blank" rel="noreferrer" className="shrink-0">
          <Button variant="outline">Open my website</Button>
        </a>
      </div>

      {editorUrl ? (
        <SiteEditorFrame
          editorUrl={editorUrl}
          onReload={reload}
          onSaved={({ siteUrl, slug }) => {
            // A new address after a rename: show the current link.
            setSite((s) => (s ? { ...s, siteUrl, slug: slug ?? s.slug } : s));
            window.scrollTo({ top: 0, behavior: "smooth" });
          }}
        />
      ) : (
        <Card>
          <CardDescription>
            <EditOnSiteVault slug={site.slug} />
          </CardDescription>
        </Card>
      )}
    </div>
  );
}

"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { getWebsiteEditor } from "@/lib/api/browser";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

// "Your website" (2026-11-19). SiteVault's own editor, inside AdVault: the
// API mints a one-time, 60-second sign-in link (GET /website/editor) and the
// frame opens it, so the customer never sees a SiteVault sign-in or leaves
// AdVault. SiteVault lets only this origin frame the editor and sends its
// height and "saved" messages only here; we accept them only from SiteVault
// and only from this frame.

const SITEVAULT_ORIGIN = "https://sitevault.3pandalabs.com";
const MIN_HEIGHT = 900;
const MAX_HEIGHT = 30_000;

type Site = { slug: string; siteUrl: string; live: boolean; madeHere: boolean };

export default function WebsitePage() {
  const [site, setSite] = useState<Site | null>(null);
  const [editorUrl, setEditorUrl] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [height, setHeight] = useState(MIN_HEIGHT);
  const frame = useRef<HTMLIFrameElement>(null);

  // The link works once, so every (re)load of the editor asks for a new one.
  const fetchEditor = useCallback(() => {
    getWebsiteEditor()
      .then((r) => {
        setSite(r.site);
        setEditorUrl(r.editorUrl);
        setHeight(MIN_HEIGHT);
        setState("ready");
      })
      .catch(() => setState("error"));
  }, []);

  function load() {
    setState("loading");
    fetchEditor();
  }

  useEffect(() => {
    fetchEditor();
  }, [fetchEditor]);

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.origin !== SITEVAULT_ORIGIN || e.source !== frame.current?.contentWindow) return;
      const d = e.data as { type?: unknown; height?: unknown; slug?: unknown; siteUrl?: unknown } | null;
      if (d?.type === "sitevault:height" && typeof d.height === "number" && Number.isFinite(d.height)) {
        setHeight(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.ceil(d.height))));
      } else if (d?.type === "sitevault:saved" && typeof d.siteUrl === "string" && d.siteUrl.startsWith("https://")) {
        // A new address after a rename: show the current link.
        const siteUrl = d.siteUrl;
        setSite((s) => (s ? { ...s, siteUrl, slug: typeof d.slug === "string" ? d.slug : s.slug } : s));
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  if (state === "loading" && !site) {
    return <p className="text-sm text-zinc-500">Loading your website…</p>;
  }

  if (state === "error") {
    return (
      <Card>
        <CardTitle>Your website</CardTitle>
        <CardDescription>We couldn&apos;t open your website just now.</CardDescription>
        <div className="mt-4">
          <Button onClick={load}>Try again</Button>
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
        <>
          <iframe
            ref={frame}
            key={editorUrl}
            src={editorUrl}
            title="Edit your website"
            className="block w-full rounded-xl border border-white/10 bg-zinc-950"
            style={{ height }}
            referrerPolicy="no-referrer"
          />
          <p className="text-xs text-zinc-500">
            Editor stopped working?{" "}
            <button type="button" onClick={load} className="underline underline-offset-4 hover:text-zinc-300">
              Reload it
            </button>
          </p>
        </>
      ) : (
        <Card>
          <CardDescription>
            This website was made on SiteVault, so you edit it there with the same login.{" "}
            <a
              href={`${SITEVAULT_ORIGIN}/edit/${encodeURIComponent(site.slug)}`}
              target="_blank"
              rel="noreferrer"
              className="text-amber-300 underline underline-offset-4"
            >
              Edit it on SiteVault
            </a>
          </CardDescription>
        </Card>
      )}
    </div>
  );
}

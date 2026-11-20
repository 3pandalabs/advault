"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getWebsiteEditor } from "@/lib/api/browser";

// SiteVault's full editor inside AdVault (2026-11-19). Used by "Your website"
// (/dashboard/website) and inline on the campaign page's website card, right
// after "Make me a website" and from "Edit my website".
//
// The API mints a one-time, 60-second sign-in link (GET /website/editor) and
// the frame opens it, so the customer never sees a SiteVault sign-in or leaves
// AdVault. SiteVault lets only AdVault frame the editor and posts its messages
// only to AdVault; we accept them only from SiteVault and only from this frame:
//   sitevault:height   the page height, so the frame fits (no inner scrollbar)
//   sitevault:saved    a save landed (siteUrl/slug change after a rename)
//   sitevault:sections where sections start inside the page ({ style: px }),
//                      so `focus="style"` can scroll to the "Website style" picker

export const SITEVAULT_ORIGIN = "https://sitevault.3pandalabs.com";
const MIN_HEIGHT = 900;
const MAX_HEIGHT = 30_000;

export type EditorSite = { slug: string; siteUrl: string; live: boolean; madeHere: boolean };

/** The signed-in account's website and a fresh editor link. `reload` asks for a new link (each works once). */
export function useSiteEditor(enabled = true) {
  const [site, setSite] = useState<EditorSite | null>(null);
  const [editorUrl, setEditorUrl] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  const fetchEditor = useCallback(() => {
    getWebsiteEditor()
      .then((r) => {
        setSite(r.site);
        setEditorUrl(r.editorUrl);
        setState("ready");
      })
      .catch(() => setState("error"));
  }, []);

  const reload = useCallback(() => {
    setState("loading");
    fetchEditor();
  }, [fetchEditor]);

  useEffect(() => {
    if (enabled) fetchEditor();
  }, [enabled, fetchEditor]);

  return { site, setSite, editorUrl, state, reload };
}

export function SiteEditorFrame({
  editorUrl,
  onReload,
  onSaved,
  focus,
}: {
  editorUrl: string;
  onReload: () => void;
  /** After a save: the site's current address (it changes on a rename). */
  onSaved?: (s: { siteUrl: string; slug: string | null }) => void;
  /** Scroll the page to this editor section once it has loaded. */
  focus?: "style";
}) {
  // Height per link: a new link is a fresh page, so it starts at the minimum
  // again (and is focused again).
  const [fit, setFit] = useState<{ url: string; height: number } | null>(null);
  const height = fit?.url === editorUrl ? fit.height : MIN_HEIGHT;
  const frame = useRef<HTMLIFrameElement>(null);
  const focusedFor = useRef<string | null>(null);
  const onSavedRef = useRef(onSaved);
  useEffect(() => {
    onSavedRef.current = onSaved;
  });

  useEffect(() => {
    function scrollToFrame(offset: number) {
      const el = frame.current;
      if (!el) return;
      window.scrollTo({ top: Math.max(0, el.getBoundingClientRect().top + window.scrollY + offset - 16), behavior: "smooth" });
    }
    function onMessage(e: MessageEvent) {
      if (e.origin !== SITEVAULT_ORIGIN || e.source !== frame.current?.contentWindow) return;
      const d = e.data as { type?: unknown; height?: unknown; slug?: unknown; siteUrl?: unknown; style?: unknown } | null;
      if (d?.type === "sitevault:height" && typeof d.height === "number" && Number.isFinite(d.height)) {
        setFit({ url: editorUrl, height: Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.ceil(d.height))) });
      } else if (d?.type === "sitevault:saved" && typeof d.siteUrl === "string" && d.siteUrl.startsWith("https://")) {
        onSavedRef.current?.({ siteUrl: d.siteUrl, slug: typeof d.slug === "string" ? d.slug : null });
      } else if (
        d?.type === "sitevault:sections" &&
        focus === "style" &&
        focusedFor.current !== editorUrl &&
        typeof d.style === "number" &&
        Number.isFinite(d.style) &&
        d.style >= 0 &&
        d.style < MAX_HEIGHT
      ) {
        focusedFor.current = editorUrl;
        scrollToFrame(d.style);
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [focus, editorUrl]);

  // Without section offsets (an older SiteVault), at least bring the editor into view.
  function onLoad() {
    if (!focus) return;
    const el = frame.current;
    setTimeout(() => {
      if (focusedFor.current !== editorUrl && el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 600);
  }

  return (
    <>
      <iframe
        ref={frame}
        key={editorUrl}
        src={editorUrl}
        title="Edit your website"
        className="block w-full rounded-xl border border-white/10 bg-zinc-950"
        style={{ height }}
        referrerPolicy="no-referrer"
        onLoad={onLoad}
      />
      <p className="text-xs text-zinc-500">
        Editor stopped working?{" "}
        <button type="button" onClick={onReload} className="underline underline-offset-4 hover:text-zinc-300">
          Reload it
        </button>
      </p>
    </>
  );
}

/** A website built on SiteVault keeps its own editor there. */
export function EditOnSiteVault({ slug }: { slug: string }) {
  return (
    <>
      This website was made on SiteVault, so you edit it there with the same login.{" "}
      <a
        href={`${SITEVAULT_ORIGIN}/edit/${encodeURIComponent(slug)}`}
        target="_blank"
        rel="noreferrer"
        className="text-amber-300 underline underline-offset-4"
      >
        Edit it on SiteVault
      </a>
    </>
  );
}

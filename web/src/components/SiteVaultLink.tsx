"use client";

import { sitevaultSigninUrl } from "@/lib/api/browser";

const SITEVAULT = "https://sitevault.3pandalabs.com";

// A link to a SiteVault page that arrives signed in (one-tap sign-in,
// 2026-11-20, api routes/signinHandoff.ts). The plain href is the fallback:
// no JS, an older API, SiteVault not set up here, or an admin (signs in by
// hand) all just open the normal SiteVault page, which asks to sign in.
//
// On click we open the tab at once (a popup opened after an await is
// blocked), ask the API for a one-time 60 s link, then point the tab at it.
export function SiteVaultLink({ path, className, children }: { path: string; className?: string; children: React.ReactNode }) {
  const plain = `${SITEVAULT}${path}`;

  async function open(e: React.MouseEvent<HTMLAnchorElement>) {
    // Let modified clicks (new window, new tab) use the plain link.
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    const tab = window.open("about:blank", "_blank");
    if (tab) tab.opener = null;
    let url = plain;
    try {
      url = (await sitevaultSigninUrl(path)).url ?? plain;
    } catch {
      // Signed out or the API is older: the plain link.
    }
    if (tab) tab.location.href = url;
    else window.location.href = url;
  }

  return (
    <a href={plain} target="_blank" rel="noreferrer" className={className} onClick={open}>
      {children}
    </a>
  );
}

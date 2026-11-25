"use client";

// Our own visit counter (2026-11-25): adds one to a daily total in
// 3pandalabs/admin visits/ (admin.3pandalabs.com > Visitors). No cookie, no
// visitor id; only the referring host, the link's utm tags and the FIRST path
// segment leave the page, so no campaign id or token does. `?nocount=1` stops
// counting in this browser. Described on the privacy page: change both together.
const URL_ = "https://counts.3pandalabs.com/c";
const HOST = "advault.3pandalabs.com";

let first = true;

export function countPage(pathname: string): void {
  if (typeof window === "undefined" || window.location.hostname !== HOST) return;
  try {
    const q = new URLSearchParams(window.location.search);
    try {
      const n = q.get("nocount");
      if (n === "1") window.localStorage.setItem("nocount", "1");
      if (n === "0") window.localStorage.removeItem("nocount");
      if (window.localStorage.getItem("nocount") === "1") return;
    } catch {
      // storage blocked: count as usual
    }
    if (pathname.startsWith("/dashboard/admin")) return;
    let h = "";
    try {
      h = document.referrer ? new URL(document.referrer).hostname : "";
    } catch {
      // odd referrer: treat as none
    }
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    const landing = first && nav?.type !== "reload" && nav?.type !== "back_forward";
    first = false;
    const ad = q.has("gclid") || q.has("gbraid") || q.has("wbraid");
    navigator.sendBeacon(
      URL_,
      JSON.stringify({
        v: landing ? 1 : 0,
        h,
        s: q.get("utm_source") ?? "",
        m: q.get("utm_medium") ?? "",
        g: ad ? 1 : 0,
        p: `/${pathname.split("/")[1] ?? ""}`,
      }),
    );
  } catch {
    // counting must never break a page
  }
}

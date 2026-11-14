import type { MetadataRoute } from "next";

// Web app manifest, served at /manifest.webmanifest. Two consumers:
//
// 1. Browsers offering "Install app" / "Add to Home screen". No service
//    worker: nothing here needs to work offline.
// 2. The Android app (android/, a Trusted Web Activity built with Bubblewrap),
//    whose twa-manifest.json mirrors the name, colours, icons and start URL
//    below. Change one, change the other, and rebuild the AAB.
//
// The raster icons are rendered by infra/play-store/tools/build-graphics.mjs;
// rerun it rather than editing them by hand.
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/dashboard",
    name: "AdVault",
    short_name: "AdVault",
    description: "YouTube and Shorts ads for local businesses. Upload a few photos, pick your area, set a budget.",
    // Signed out, the dashboard layout sends people to /login.
    start_url: "/dashboard",
    scope: "/",
    display: "standalone",
    background_color: "#09090b",
    theme_color: "#09090b",
    categories: ["business", "productivity"],
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "New ad", short_name: "New ad", url: "/dashboard/campaigns/new", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
    ],
  };
}

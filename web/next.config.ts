import type { NextConfig } from "next";

// Fail the build rather than shipping a bundle that points at localhost.
//
// NEXT_PUBLIC_* is inlined at build time, so an unset value doesn't error — it
// silently compiles the fallback in src/lib/api/browser.ts into every browser
// bundle. Server-rendered pages keep working (they read INTERNAL_API_URL at
// runtime), so the site looks healthy while every client-side call fails with a
// bare network error. That exact failure shipped on RsvpVault on 2026-07-27 and
// cost a debugging round; .env.production supplies the values, and this
// assertion is what makes a future omission loud instead of silent.
if (process.env.NODE_ENV === "production" && !process.env.NEXT_PUBLIC_API_URL) {
  throw new Error(
    "NEXT_PUBLIC_API_URL is unset at build time. It is inlined into the browser " +
      "bundle, so wrangler.jsonc `vars` cannot supply it — set it in web/.env.production.",
  );
}

const nextConfig: NextConfig = {
  // Creative thumbnails and preview videos arrive as short-lived R2 presigned
  // URLs on the *.r2.cloudflarestorage.com host. next/image would cache a URL
  // that expires in ten minutes and then serve a dead link from its own cache
  // key, so the optimizer is off.
  images: { unoptimized: true },
};

export default nextConfig;

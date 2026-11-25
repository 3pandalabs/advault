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

// Security headers for everything the Worker answers. Files under public/ and
// _next/static are served by Workers static assets without running the Worker:
// public/_headers repeats these for them. Keep the two in step.
//
// Nothing frames AdVault (it frames SiteVault's editor, and the Android app is
// a Trusted Web Activity, a top-level page), so framing is denied outright.
// HSTS is deliberately modest: one day, this host only, no preload.
const SECURITY_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Strict-Transport-Security", value: "max-age=86400" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  // Report-Only: shows up in the browser console and blocks nothing. Enforce
  // only after checking sign-in, uploads, previews and checkout with it clean.
  // Google OAuth and Stripe Checkout are full-page redirects, so they need no
  // entries; creatives and uploads use presigned R2 URLs.
  {
    key: "Content-Security-Policy-Report-Only",
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https://*.r2.cloudflarestorage.com",
      "media-src 'self' blob: https://*.r2.cloudflarestorage.com",
      `connect-src 'self' ${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080"} https://*.r2.cloudflarestorage.com https://counts.3pandalabs.com`,
      "frame-src https://sitevault.3pandalabs.com",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; "),
  },
];

const PRODUCTION_HOST = { type: "host", value: "^advault\.3pandalabs\.com$" } as const;

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },

  // http -> https. Cloudflare overwrites X-Forwarded-Proto with the scheme the
  // visitor used, and also sends CF-Visitor ({"scheme":"http"}); either one
  // saying http redirects. The ^...$ anchors are load-bearing: OpenNext tests
  // `value` unanchored, where "http" would also match "https" and loop. The
  // production host is required so `next start` on localhost (Next sets
  // X-Forwarded-Proto: http itself) and Worker previews never redirect.
  async redirects() {
    return [
      { type: "header", key: "x-forwarded-proto", value: "^http$" } as const,
      { type: "header", key: "cf-visitor", value: '^.*"scheme":\s*"http".*$' } as const,
    ].flatMap((insecure) =>
      // "/" needs its own rule: with "/:path*" OpenNext sends it to a literal
      // "/:path*" (plain `next start` does not).
      ["/", "/:path+"].map((path) => ({
        source: path,
        has: [PRODUCTION_HOST, insecure],
        destination: `https://advault.3pandalabs.com${path}`,
        permanent: true,
      })),
    );
  },

  // Creative thumbnails and preview videos arrive as short-lived R2 presigned
  // URLs on the *.r2.cloudflarestorage.com host. next/image would cache a URL
  // that expires in ten minutes and then serve a dead link from its own cache
  // key, so the optimizer is off.
  images: { unoptimized: true },
};

export default nextConfig;

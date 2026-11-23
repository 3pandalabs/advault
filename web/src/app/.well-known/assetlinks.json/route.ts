// Digital Asset Links for the Android app (android/, package
// com.threepandalabs.advault). Chrome checks this file before it opens the
// site as a Trusted Web Activity; without a matching fingerprint the app shows
// a browser URL bar, and Play reviewers reject that as a "webview wrapper".
//
// A route handler rather than a file in public/: dot-directories are handled
// inconsistently by the Workers asset upload, and this guarantees
// `Content-Type: application/json`, which the Digital Asset Links API requires.
//
// TWO fingerprints belong here once the app exists on Play:
//   1. The UPLOAD key (below): signs the AAB we upload and any locally built APK.
//   2. The Play App Signing key: Google re-signs what users install. Copy its
//      SHA-256 from Play Console → Test and release → Setup → App signing, add
//      it below, and redeploy the web app BEFORE promoting a release. Until
//      then, installs from Play show a URL bar.
// See infra/play-store/README.md.
const SHA256_CERT_FINGERPRINTS = [
  // Upload key: C:\Users\Anil\Documents\keys\advault-upload.jks, alias "upload".
  "80:FA:E2:76:43:A7:EC:78:D6:9D:62:F6:AC:2B:AB:E9:91:B2:29:9E:59:89:74:2B:BE:31:82:4F:43:14:7F:03",
  // Play App Signing key (classical), Play Console app 4973181122451946747, added 2026-11-22.
  "DB:4C:7C:A9:D6:17:12:99:0D:83:F6:19:63:B2:EF:6B:18:3E:70:D1:36:63:2B:16:B6:56:46:A8:E1:F8:65:CE",
  // Play also lists these (App signing -> "Copy all certificate fingerprints"):
  // the "Quantum-ready (beta)" post-quantum key and a further signing
  // certificate. Newer phones can present one of them, and Chrome then falls
  // back to a Custom Tab with an address bar (seen on a Galaxy Fold,
  // 2026-11-22). List every fingerprint Play shows.
  "BE:F8:3B:1B:29:F7:1A:1B:77:8B:C3:BD:FD:12:0A:0A:53:67:72:77:F3:F6:99:6D:10:52:51:8A:65:33:8E:0B",
  "4C:5F:91:0B:03:FD:18:DA:86:EF:8D:76:E6:9D:35:7B:29:7B:E3:89:9C:C5:A0:45:A2:C6:B1:89:23:42:36:6A",
];

const statements = [
  {
    relation: ["delegate_permission/common.handle_all_urls"],
    target: {
      namespace: "android_app",
      package_name: "com.threepandalabs.advault",
      sha256_cert_fingerprints: SHA256_CERT_FINGERPRINTS,
    },
  },
];

export const dynamic = "force-static";

export function GET() {
  return new Response(JSON.stringify(statements, null, 2), {
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=3600" },
  });
}

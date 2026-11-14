// Digital Asset Links for the Android app (android/, package
// com.threepanda.advault). Chrome checks this file before it opens the
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
  // Play App Signing key: ADD HERE after the app is created in Play Console.
];

const statements = [
  {
    relation: ["delegate_permission/common.handle_all_urls"],
    target: {
      namespace: "android_app",
      package_name: "com.threepanda.advault",
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

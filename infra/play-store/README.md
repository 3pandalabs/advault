# AdVault on Google Play

The Android app is a **Trusted Web Activity** (`android/`, generated with Bubblewrap): Chrome shows `https://advault.3pandalabs.com` full screen, without a URL bar, starting at `/dashboard` (signed out, it goes to `/login`). There's no app code to keep in step. Every web deploy updates the app immediately. Rebuild the AAB only when the name, icon, colours, start URL, shortcuts or version change.

Package `com.threepanda.advault` · listing copy and policy answers: `listing.md`.

## Signing

- Upload key: `C:\Users\Anil\Documents\keys\advault-upload.jks`, alias `upload` (password in Claude memory `advault-upload-key`). **Back it up off this PC.** If it's lost, request an upload-key reset in Play Console.
- Google re-signs installs with the Play App Signing key. After creating the app, copy that key's SHA-256 (Play Console → Test and release → Setup → App signing) into `web/src/app/.well-known/assetlinks.json/route.ts` and redeploy the web app **before** promoting a release, or Play installs show a URL bar.
- Check: https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://advault.3pandalabs.com&relation=delegate_permission/common.handle_all_urls

## Build

```bash
cd android
export JAVA_HOME=~/.bubblewrap/jdk/jdk-17.0.21+9 ANDROID_HOME=~/.bubblewrap/android_sdk
# bump appVersionCode (+1 every upload) and appVersionName in twa-manifest.json AND app/build.gradle
./gradlew bundleRelease assembleRelease
# sign (gradle output is unsigned):
#   AAB: jarsigner -keystore ../../keys/advault-upload.jks app/build/outputs/bundle/release/app-release.aab upload
#   APK: apksigner sign --ks ../../keys/advault-upload.jks --ks-key-alias upload --out app-release-signed.apk app/build/outputs/apk/release/app-release-unsigned.apk
```

Or `npx @bubblewrap/cli build` (prompts for the keystore password and signs both).

## Graphics and screenshots

```bash
cd infra/play-store/tools && npm install
npm run graphics      # PWA icons, android/ launcher/splash/shortcut PNGs, graphics/icon-512.png and the feature graphic (artwork mirrors web/src/app/icon.svg)
```

Screenshots: `screenshots/raw/` (1080×1920) and `screenshots/framed/` (captioned; upload these). `npm run screenshots` captures the three public ones (home, demos, pricing) from the live site, or from `next dev` with `AV_SITE=http://localhost:3000`. The signed-in ones (`04-photos.png`, `05-campaign.png`, `06-results.png`; captions in `frame-screenshots.mjs`) are taken on a phone from the installed app and dropped into `raw/` at 1080×1920. Then `npm run frame`.

Signed builds of 1.0.0 (1) are in `C:UsersAnilDocumentskeysadvault-builds` (not in git).

## First release (manual)

1. Play Console → Create app "AdVault", app, free; accept declarations.
2. Fill **App content** and **Store listing** from `listing.md`; upload the icon, feature graphic and framed screenshots.
3. Test and release → **Internal testing** → create release → upload the signed `app-release.aab`.
4. Copy the App Signing SHA-256 into `assetlinks.json/route.ts`, redeploy web, verify with the link above, and install from the internal track: no URL bar = verified.
5. Promote to Production and submit for review. (Organization account: no 12-tester/14-day closed test rule.)

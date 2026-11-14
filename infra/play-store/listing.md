# Google Play listing: AdVault

Package `com.threepanda.advault` · Developer: 3PandaLabs LLC (organization account) · Category: **Business** · Free to install · No ads in the app · No purchases through Google Play Billing. AdVault sells YouTube ads for local businesses ($10 per ad made, $19/month to keep it running, plus the customer's ad budget), paid by card through Stripe Checkout. US only. Google isn't requiring Play Billing for US users while the US court order stands (support.google.com/googleplay/android-developer/answer/15582165), and the ad itself runs on YouTube, outside the app. Answer the Play Console payments declaration to match.

## App name (30)
AdVault: YouTube Ads Maker

## Short description (80)
YouTube and Shorts ads for your local business, made from your own photos.

## Full description (4000)
Get your local business on YouTube without hiring an agency or learning Google Ads.

Upload a few photos of your shop, your team or your work, or snap them right in the app. AdVault turns them into a vertical Shorts ad and a widescreen YouTube ad, with a script written for your kind of business. Pick the area around you, set a daily budget, and we run the ad on YouTube for people nearby.

HOW IT WORKS
• Add photos from your gallery or take them with your camera.
• We write the script and make the video, in both Shorts (9:16) and YouTube (16:9) shapes.
• Choose where your customers are and how much to spend a day.
• We launch it on YouTube and keep it running. You see views, clicks and spend in the app.
• Already have a video? Upload it instead, free. We review it before it goes live.

SIMPLE PRICING
• $10 for each ad we make.
• $19 a month to keep it running, plus your own ad budget, which goes to Google.
• No contract. Cancel any time.

Made for plumbers, salons, dentists, realtors, restaurants and every local business that wants to be seen by the people around it.

Delete your account any time from Settings.

Made by 3PandaLabs.

## Contact
- Email: support@3pandalabs.com
- Website: https://advault.3pandalabs.com
- Privacy policy: https://advault.3pandalabs.com/privacy
- Account deletion URL: https://advault.3pandalabs.com/privacy#delete-account (public; says Settings → Delete account in the app or on the web, or email privacy@3pandalabs.com for people who can't sign in)

## Graphics (infra/play-store/)
- `graphics/icon-512.png`: hi-res icon (512×512, opaque)
- `graphics/feature-graphic.png`: 1024×500
- Phone screenshots: 2–8, 1080×1920. See README.md.

## App content answers
- **Ads:** No (the app shows no ads; it makes ads for the customer).
- **App access:** Everything past the home page needs sign-in. Give reviewers a test account (create one on the live site and paste its email + password into "App access" → "All or some functionality is restricted"). Note that buying an ad charges a real card.
- **Target audience:** 18+ (business owners).
- **Content rating (IARC):** No user-to-user interaction; no location sharing; digital purchases: yes (ad creation and placement, paid by card on the website). Expected rating: Everyone.
- **News app:** No. **Government app:** No. **Health:** No.
- **Financial features:** None (no loans, banking, trading or crypto).
- **Data safety:**
  - Collected: Name (optional), Email address, Phone number (optional), User IDs, Photos (the business photos the user uploads to make their ad), Videos (an optional ad video the user uploads), Other user-generated content (business name, offer text, ad copy), Purchase history (what ads were bought). Card details are entered on Stripe's page and never reach AdVault.
  - Purpose: App functionality, Account management.
  - Shared with third parties: Ad content (photos, videos, business name, landing page) goes to Google/YouTube to run the ad the user asked for. Disclose that as sharing for App functionality. Stripe processes card payments as a service provider.
  - Encrypted in transit: Yes. Users can request deletion: Yes (in-app + URL above).
  - No location, contacts, audio or device identifiers. No analytics SDK, no crash SDK.
- **Permissions in the AAB:** none user-facing (verified with `aapt2 dump badging` on build 1.0.0 (1): only the library's internal non-exported receiver permission). "Take photo" uses Chrome's own camera permission, asked the first time it's used.

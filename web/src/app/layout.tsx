import type { Metadata } from "next";
import { GradientBackdrop } from "@/components/GradientBackdrop";
import { PandaHelper } from "@/components/PandaHelper";
import { Footer } from "@/components/Footer";
import { AdVisitTracker } from "@/components/AdVisitTracker";
import { AppContextRecorder } from "@/components/AppPayments";
import "./globals.css";

// Titles and share tags follow 3pandalabs/brand brand.md "Consistency rules":
// home = "<App> — <line> | by 3PandaLabs", other pages = "<Page> — AdVault",
// og:image = the 1200x630 card generated from brand/og (public/og.png).
const SITE_URL = "https://advault.3pandalabs.com";
const TITLE = "AdVault — YouTube & Shorts ads for local businesses | by 3PandaLabs";
const DESCRIPTION =
  "Self-serve YouTube and Shorts ads for local businesses. Upload a few photos, pick your ZIP codes, add an ad budget.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: TITLE, template: "%s — AdVault" },
  description: DESCRIPTION,
  openGraph: {
    type: "website",
    siteName: "AdVault by 3PandaLabs",
    url: SITE_URL,
    title: TITLE,
    description: DESCRIPTION,
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "AdVault by 3PandaLabs" }],
  },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION, images: ["/og.png"] },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="flex min-h-screen flex-col bg-zinc-950 text-zinc-100 antialiased">
        <GradientBackdrop />
        <AdVisitTracker />
        <AppContextRecorder />
        <div className="flex-1">{children}</div>
        <Footer />
        <PandaHelper />
      </body>
    </html>
  );
}

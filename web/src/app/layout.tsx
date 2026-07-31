import type { Metadata } from "next";
import { GradientBackdrop } from "@/components/GradientBackdrop";
import { Footer } from "@/components/Footer";
import "./globals.css";

export const metadata: Metadata = {
  title: "AdVault by 3PandaLabs",
  description:
    "Self-serve YouTube and Shorts ads for local businesses. Upload a few photos, pick your ZIP codes, set a daily budget.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="flex min-h-screen flex-col bg-zinc-950 text-zinc-100 antialiased">
        <GradientBackdrop />
        <div className="flex-1">{children}</div>
        <Footer />
      </body>
    </html>
  );
}

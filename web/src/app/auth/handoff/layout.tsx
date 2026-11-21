import type { Metadata } from "next";

// The URL carries a one-time sign-in token: never send it on as a Referer,
// never index the page.
export const metadata: Metadata = {
  title: "Signing you in",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default function HandoffLayout({ children }: { children: React.ReactNode }) {
  return children;
}

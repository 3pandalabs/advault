import type { Metadata } from "next";

// The URL carries a signed Confirm / Decline token from a booking email:
// never send it on as a Referer, never index the page.
export const metadata: Metadata = {
  title: "Your booking request",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default function LeadActionLayout({ children }: { children: React.ReactNode }) {
  return children;
}

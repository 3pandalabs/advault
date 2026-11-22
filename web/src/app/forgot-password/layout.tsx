import type { Metadata } from "next";

// Client page, so its title lives here ("<Page> — <App>" via the root template).
export const metadata: Metadata = { title: "Forgot password" };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}

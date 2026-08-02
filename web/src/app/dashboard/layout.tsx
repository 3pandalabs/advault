"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { clearTokens, getMe, getTokens, type Me } from "@/lib/api/browser";
import { WordmarkName, WordmarkTag } from "@/components/Wordmark";
import { Button } from "@/components/ui/button";

// The dashboard is client-rendered and talks to the API directly from the
// browser rather than through Server Components. Two reasons:
//   - it sidesteps the orange-to-orange restriction entirely (see
//     wrangler.jsonc) — no server-side fetch, no DNS-only hostname needed;
//   - the API is the only real authorization boundary anyway, so putting a
//     rendering layer in front of it buys nothing but a second place for the
//     auth check to be subtly wrong.
//
// This layout's redirect is convenience, not security. Every route below it is
// enforced by the API's requireAuth; a user who defeats this check reaches an
// API that answers 401.
export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    if (!getTokens().access) {
      router.replace("/login");
      return;
    }
    getMe()
      .then(setMe)
      .catch(() => {
        clearTokens();
        router.replace("/login");
      })
      .finally(() => setChecked(true));
  }, [router]);

  function signOut() {
    clearTokens();
    router.replace("/login");
  }

  if (!checked) {
    return <div className="px-6 py-16 text-center text-sm text-zinc-500">Loading…</div>;
  }

  return (
    <div>
      <header className="border-b border-white/10">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between px-6 py-4">
          <div className="text-lg font-semibold tracking-tight">
            <Link href="/dashboard">
              <WordmarkName />
            </Link>
            <WordmarkTag />
          </div>
          <nav className="flex items-center gap-1 text-sm">
            <Link
              href="/dashboard"
              className="rounded-lg px-3 py-2 text-zinc-300 hover:bg-white/10"
            >
              Campaigns
            </Link>
            <Link
              href="/dashboard/wallet"
              className="rounded-lg px-3 py-2 text-zinc-300 hover:bg-white/10"
            >
              Balance
            </Link>
            <Link
              href="/dashboard/settings"
              className="rounded-lg px-3 py-2 text-zinc-300 hover:bg-white/10"
            >
              Settings
            </Link>
            <Button variant="ghost" size="sm" onClick={signOut}>
              Sign out
            </Button>
          </nav>
        </div>
        {me?.businessName && (
          <div className="mx-auto w-full max-w-5xl px-6 pb-3 text-xs text-zinc-500">
            {me.businessName}
          </div>
        )}
      </header>
      <main className="mx-auto w-full max-w-5xl px-6 py-8">{children}</main>
    </div>
  );
}

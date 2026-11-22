"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect } from "react";
import { ApiError, exchangeSigninHandoff, setTokens } from "@/lib/api/browser";
import { safeNextPath } from "@/lib/safeNext";

// One-tap sign-in from SiteVault (2026-11-20, api routes/signinHandoff.ts).
// SiteVault's "Video ads" / "Make a YouTube ad" links land here as
// /auth/handoff?t=<60 s single-use token>&to=<path>. We trade the token for
// the normal session (the same token pair /auth/login gives), then go to `to`
// (relative paths only; default /dashboard). Any failure (expired, used,
// an older API without the route) goes to the normal /login, never an error
// that says why. The one exception: an admin (`handoff_admin`) lands on
// /login?handoff=admin, which says admins sign in there directly.

// Tokens already sent, per page load. A ref was not enough: the component can
// mount twice (Suspense), and the second POST was always refused as "reused".
const sent = new Set<string>();

function Handoff() {
  const router = useRouter();
  const params = useSearchParams();

  useEffect(() => {
    const to = safeNextPath(params.get("to"));
    const token = params.get("t") ?? "";
    const toLogin = (extra = "") => router.replace(`/login?next=${encodeURIComponent(to)}${extra}`);
    if (!token) return toLogin();
    if (sent.has(token)) return;
    sent.add(token);
    exchangeSigninHandoff(token)
      .then((t) => {
        setTokens(t.accessToken, t.refreshToken);
        router.replace(to);
      })
      .catch((err) => toLogin(err instanceof ApiError && err.code === "handoff_admin" ? "&handoff=admin" : ""));
  }, [params, router]);

  return <p className="text-sm text-zinc-400">Signing you in…</p>;
}

export default function HandoffPage() {
  return (
    <main className="mx-auto w-full max-w-md px-6 py-16 text-center">
      <Suspense fallback={<p className="text-sm text-zinc-400">Signing you in…</p>}>
        <Handoff />
      </Suspense>
    </main>
  );
}

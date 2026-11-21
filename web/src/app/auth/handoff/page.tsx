"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef } from "react";
import { exchangeSigninHandoff, setTokens } from "@/lib/api/browser";
import { safeNextPath } from "@/lib/safeNext";

// One-tap sign-in from SiteVault (2026-11-20, api routes/signinHandoff.ts).
// SiteVault's "Video ads" / "Make a YouTube ad" links land here as
// /auth/handoff?t=<60 s single-use token>&to=<path>. We trade the token for
// the normal session (the same token pair /auth/login gives), then go to `to`
// (relative paths only; default /dashboard). Any failure (expired, used,
// admin, an older API without the route) goes to the normal /login, never an
// error that says why.
function Handoff() {
  const router = useRouter();
  const params = useSearchParams();
  const started = useRef(false);

  useEffect(() => {
    // Once: the token works a single time (and React may run effects twice in dev).
    if (started.current) return;
    started.current = true;
    const to = safeNextPath(params.get("to"));
    const token = params.get("t") ?? "";
    const toLogin = () => router.replace(`/login?next=${encodeURIComponent(to)}`);
    if (!token) return toLogin();
    exchangeSigninHandoff(token)
      .then((t) => {
        setTokens(t.accessToken, t.refreshToken);
        router.replace(to);
      })
      .catch(toLogin);
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

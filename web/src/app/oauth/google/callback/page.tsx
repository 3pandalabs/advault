"use client";

import { useRouter, useSearchParams, type ReadonlyURLSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { api } from "@/lib/api/browser";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";

// Google redirects here after the consent screen. The page forwards the code
// and state to the API rather than exchanging them itself — the OAuth client
// secret must never reach a browser bundle, so the token exchange is
// server-side by necessity, not by preference.
//
// The URL must match GOOGLE_ADS redirect settings exactly. It is derived from
// WEB_ORIGIN on the API side (lib/googleAds/env.ts) so localhost and production
// cannot drift apart.

type State =
  | { kind: "working" }
  | { kind: "done" }
  | { kind: "choose"; customerIds: string[]; code: string; state: string }
  | { kind: "error"; message: string };

// Whether the callback URL is usable is knowable at render time, so it is
// derived here rather than assigned from inside the effect. Calling setState
// synchronously in an effect body causes a cascading render, and the lint rule
// that catches it is right: there is no external system to synchronise with in
// the "Google sent us nothing usable" case.
function initialState(params: URLSearchParams | ReadonlyURLSearchParams): State {
  const denied = params.get("error");
  if (denied) {
    return {
      kind: "error",
      message:
        denied === "access_denied"
          ? "You cancelled the Google connection. Nothing was changed."
          : `Google returned an error: ${denied}`,
    };
  }
  if (!params.get("code") || !params.get("state")) {
    return { kind: "error", message: "That link is missing information from Google." };
  }
  return { kind: "working" };
}

function CallbackInner() {
  const router = useRouter();
  const params = useSearchParams();
  const [state, setState] = useState<State>(() => initialState(params));

  useEffect(() => {
    const code = params.get("code");
    const oauthState = params.get("state");
    // Already resolved to an error at render — nothing to exchange.
    if (!code || !oauthState || params.get("error")) return;

    api<{ needsSelection?: boolean; customerIds?: string[] }>(
      "/ad-accounts/google/callback",
      { method: "POST", body: JSON.stringify({ code, state: oauthState }) },
    )
      .then((result) => {
        if (result?.needsSelection && result.customerIds) {
          setState({ kind: "choose", customerIds: result.customerIds, code, state: oauthState });
          return;
        }
        setState({ kind: "done" });
        router.replace("/dashboard/settings");
      })
      .catch(() =>
        setState({
          kind: "error",
          message: "Could not finish connecting your Google Ads account. Please try again.",
        }),
      );
  }, [params, router]);

  async function choose(customerId: string) {
    if (state.kind !== "choose") return;
    setState({ kind: "working" });
    try {
      await api("/ad-accounts/google/callback", {
        method: "POST",
        body: JSON.stringify({ code: state.code, state: state.state, customerId }),
      });
      router.replace("/dashboard/settings");
    } catch {
      // An authorization code is single-use, so a failure here cannot be
      // retried with the same code — the advertiser has to start over.
      setState({
        kind: "error",
        message: "That connection attempt expired. Please start again from Settings.",
      });
    }
  }

  return (
    <main className="mx-auto w-full max-w-md px-6 py-16">
      <Card>
        {state.kind === "working" && (
          <>
            <CardTitle>Connecting your Google Ads account…</CardTitle>
            <CardDescription>This usually takes a couple of seconds.</CardDescription>
          </>
        )}

        {state.kind === "choose" && (
          <>
            <CardTitle>Which account should AdVault use?</CardTitle>
            <CardDescription>
              Your Google login can reach more than one Google Ads account.
            </CardDescription>
            <div className="mt-4 space-y-2">
              {state.customerIds.map((id) => (
                <Button key={id} variant="outline" className="w-full" onClick={() => choose(id)}>
                  {id}
                </Button>
              ))}
            </div>
          </>
        )}

        {state.kind === "error" && (
          <>
            <CardTitle>Could not connect</CardTitle>
            <CardDescription>{state.message}</CardDescription>
            <div className="mt-4">
              <Button onClick={() => router.replace("/dashboard/settings")}>
                Back to settings
              </Button>
            </div>
          </>
        )}
      </Card>
    </main>
  );
}

export default function GoogleCallbackPage() {
  // useSearchParams needs a Suspense boundary, or the build fails on this
  // route with a missing-suspense error rather than at runtime.
  return (
    <Suspense fallback={<p className="px-6 py-16 text-center text-sm text-zinc-500">Loading…</p>}>
      <CallbackInner />
    </Suspense>
  );
}

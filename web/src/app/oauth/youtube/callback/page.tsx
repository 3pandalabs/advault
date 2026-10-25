"use client";

import { useRouter, useSearchParams, type ReadonlyURLSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { api } from "@/lib/api/browser";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";

// Google redirects here after the YouTube consent screen. Like the Google Ads
// callback, the code is forwarded to the API rather than exchanged here — the
// OAuth client secret must never reach a browser bundle.
//
// A separate route from /oauth/google/callback on purpose: it is a separate
// grant with a separate scope, and merging them would mean one callback that
// has to guess which flow it is finishing.
//
// Every failure here is recoverable by doing nothing, which the copy says out
// loud: ads keep publishing to the AdVault channel, so a failed connection
// costs the advertiser nothing.

type State =
  | { kind: "working" }
  | { kind: "done"; channelTitle: string | null }
  | { kind: "error"; message: string };

function initialState(params: URLSearchParams | ReadonlyURLSearchParams): State {
  const denied = params.get("error");
  if (denied) {
    return {
      kind: "error",
      message:
        denied === "access_denied"
          ? "You cancelled the YouTube connection. Nothing changed — your ads keep publishing to the AdVault channel."
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
    if (!code || !oauthState || params.get("error")) return;

    api<{ channel?: { channelId: string; title: string | null }; error?: string; detail?: string }>(
      "/youtube/callback",
      { method: "POST", body: JSON.stringify({ code, state: oauthState }) },
    )
      .then((result) => {
        setState({ kind: "done", channelTitle: result?.channel?.title ?? null });
        router.replace("/dashboard/settings");
      })
      .catch((err: unknown) => {
        // The one failure worth its own message: a Google account with no
        // YouTube channel. It is common in this market — a shop owner has a
        // Gmail address and has never made a channel — and it is not a problem
        // to solve, because the default already covers them.
        const message =
          err instanceof Error && err.message.includes("no_youtube_channel")
            ? "That Google account has no YouTube channel yet. Your ads will keep publishing to the AdVault channel, which needs nothing from you."
            : "Could not finish connecting your YouTube channel. Your ads keep publishing to the AdVault channel in the meantime.";
        setState({ kind: "error", message });
      });
  }, [params, router]);

  return (
    <main className="mx-auto w-full max-w-md px-6 py-16">
      <Card>
        {state.kind === "working" && (
          <>
            <CardTitle>Connecting your YouTube channel…</CardTitle>
            <CardDescription>This usually takes a couple of seconds.</CardDescription>
          </>
        )}

        {state.kind === "done" && (
          <>
            <CardTitle>Channel connected</CardTitle>
            <CardDescription>
              New ads will publish to {state.channelTitle ?? "your channel"}.
            </CardDescription>
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

export default function YouTubeCallbackPage() {
  // useSearchParams needs a Suspense boundary, or the build fails on this
  // route with a missing-suspense error rather than at runtime.
  return (
    <Suspense fallback={<p className="px-6 py-16 text-center text-sm text-zinc-500">Loading…</p>}>
      <CallbackInner />
    </Suspense>
  );
}

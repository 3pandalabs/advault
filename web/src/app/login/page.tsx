"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ApiError, login, setTokens } from "@/lib/api/browser";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { WordmarkName, WordmarkTag } from "@/components/Wordmark";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const tokens = await login(email, password);
      setTokens(tokens.accessToken, tokens.refreshToken);
      router.push("/dashboard");
    } catch (err) {
      // The API deliberately returns one generic code for both "no such
      // account" and "wrong password" — repeating that here rather than
      // guessing which it was keeps the page from becoming an enumeration
      // oracle the API just avoided being.
      setError(
        err instanceof ApiError && err.code === "invalid_credentials"
          ? "That email and password do not match."
          : "Could not sign in. Please try again.",
      );
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto w-full max-w-md px-6 py-16">
      <div className="mb-8 text-center text-lg font-semibold tracking-tight">
        <Link href="/">
          <WordmarkName />
        </Link>
        <WordmarkTag />
      </div>

      <Card>
        <h1 className="text-xl font-semibold">Log in</h1>
        <form onSubmit={onSubmit} className="mt-6 space-y-4">
          <div>
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          {error && <p className="text-sm text-red-300">{error}</p>}

          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? "Signing in…" : "Log in"}
          </Button>
        </form>
      </Card>

      <p className="mt-6 text-center text-sm text-zinc-400">
        No account yet?{" "}
        <Link href="/signup" className="text-amber-300 hover:underline">
          Create one
        </Link>
      </p>
      {/* No "forgot password" link, because there is no reset flow — the shared
          mailer has no verified sender domain for this app yet. See CLAUDE.md.
          A dead link here would be worse than its absence. */}
    </main>
  );
}

"use client";

import Link from "next/link";
import { useState } from "react";
import { requestPasswordReset } from "@/lib/api/browser";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { WordmarkName, WordmarkTag } from "@/components/Wordmark";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    // Enumeration-safe: show the same confirmation whatever happens, including
    // a network error — the API only emails an address that has an account.
    try {
      await requestPasswordReset(email);
    } catch {
      // ignored on purpose
    }
    setSent(true);
    setBusy(false);
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
        {sent ? (
          <>
            <h1 className="text-xl font-semibold">Check your email</h1>
            <p className="mt-4 text-sm text-zinc-300">
              If that email has an AdVault account, we&apos;ve sent a link to choose a new password. It works once and
              expires in 30 minutes.
            </p>
          </>
        ) : (
          <>
            <h1 className="text-xl font-semibold">Reset your password</h1>
            <p className="mt-2 text-sm text-zinc-400">Enter your email and we&apos;ll send a link to choose a new one.</p>
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
              <Button type="submit" className="w-full" disabled={busy}>
                {busy ? "Sending…" : "Email me a link"}
              </Button>
            </form>
          </>
        )}
      </Card>

      <p className="mt-6 text-center text-sm text-zinc-400">
        <Link href="/login" className="text-amber-300 hover:underline">
          Back to log in
        </Link>
      </p>
    </main>
  );
}

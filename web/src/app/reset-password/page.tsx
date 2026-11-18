"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { ApiError, confirmPasswordReset } from "@/lib/api/browser";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { WordmarkName, WordmarkTag } from "@/components/Wordmark";

function ResetForm() {
  const router = useRouter();
  const token = useSearchParams().get("token") ?? "";
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await confirmPasswordReset(token, password);
      setDone(true);
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === "invalid_or_expired_token"
          ? "That reset link is invalid or has expired. Request a new one."
          : "Could not reset your password. Please try again.",
      );
      setBusy(false);
    }
  }

  if (done) {
    return (
      <Card>
        <h1 className="text-xl font-semibold">Password changed</h1>
        <p className="mt-4 text-sm text-zinc-300">Your password has been updated. You can now log in with it.</p>
        <Button className="mt-6 w-full" onClick={() => router.push("/login")}>
          Log in
        </Button>
      </Card>
    );
  }

  if (!token) {
    return (
      <Card>
        <h1 className="text-xl font-semibold">Choose a new password</h1>
        <p className="mt-4 text-sm text-red-300">
          This reset link is missing or invalid.{" "}
          <Link href="/forgot-password" className="text-amber-300 hover:underline">
            Request a new one
          </Link>
          .
        </p>
      </Card>
    );
  }

  return (
    <Card>
      <h1 className="text-xl font-semibold">Choose a new password</h1>
      <form onSubmit={onSubmit} className="mt-6 space-y-4">
        <div>
          <Label htmlFor="password">New password</Label>
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={10}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <p className="mt-1 text-xs text-zinc-500">At least 10 characters.</p>
        </div>
        {error && <p className="text-sm text-red-300">{error}</p>}
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? "Saving…" : "Save new password"}
        </Button>
      </form>
    </Card>
  );
}

export default function ResetPasswordPage() {
  return (
    <main className="mx-auto w-full max-w-md px-6 py-16">
      <div className="mb-8 text-center text-lg font-semibold tracking-tight">
        <Link href="/">
          <WordmarkName />
        </Link>
        <WordmarkTag />
      </div>
      <Suspense>
        <ResetForm />
      </Suspense>
    </main>
  );
}

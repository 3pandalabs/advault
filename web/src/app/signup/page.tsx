"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ApiError, register, setTokens } from "@/lib/api/browser";
import { Button } from "@/components/ui/button";
import { FieldHint, Input, Label } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { WordmarkName, WordmarkTag } from "@/components/Wordmark";
import { CATEGORIES } from "@/lib/audience";
import { TERMS_VERSION } from "@/lib/compliance/texts";

// Business name and category are collected here rather than later because both
// feed the ad script directly — asking for them up front means the first
// campaign's copy is already personalised instead of generic. The list is
// shared with the campaign wizard (lib/audience.ts) because "Real estate"
// switches on the US housing-ads targeting rules there.

export default function SignupPage() {
  const router = useRouter();
  const [form, setForm] = useState({
    email: "",
    password: "",
    businessName: "",
    businessCategory: CATEGORIES[0],
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Explicit Terms acceptance (2026-11-20): recorded in terms_acceptances with
  // the version, IP and user agent (api lib/compliance).
  const [agreed, setAgreed] = useState(false);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!agreed) return;
    setBusy(true);
    setError(null);
    try {
      // termsVersion: the version this checkbox showed (POST /auth/register).
      const input = { ...form, termsVersion: TERMS_VERSION };
      const tokens = await register(input);
      setTokens(tokens.accessToken, tokens.refreshToken);
      // Ad account setup first. Sending a new advertiser straight to the
      // campaign wizard lets them build a whole campaign and only discover at
      // the launch button that there is nowhere to launch it to.
      router.push("/dashboard/onboarding");
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === "registration_failed"
          ? "That account could not be created. If you already have one, log in instead."
          : "Could not create your account. Please try again.",
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
        <h1 className="text-xl font-semibold">Create your account</h1>
        <form onSubmit={onSubmit} className="mt-6 space-y-4">
          <div>
            <Label htmlFor="businessName">Business name</Label>
            <Input
              id="businessName"
              required
              placeholder="Mike's Plumbing"
              value={form.businessName}
              onChange={set("businessName")}
            />
            <FieldHint>This is what appears in your ads.</FieldHint>
          </div>

          <div>
            <Label htmlFor="businessCategory">What do you do?</Label>
            <select
              id="businessCategory"
              value={form.businessCategory}
              onChange={set("businessCategory")}
              className="h-10 w-full rounded-lg border border-white/15 bg-white/5 px-3 text-sm text-zinc-100 focus:border-amber-400/60 focus:outline-none focus:ring-1 focus:ring-amber-400/60"
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c} className="bg-zinc-900">
                  {c}
                </option>
              ))}
            </select>
          </div>

          <div>
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={form.email}
              onChange={set("email")}
            />
          </div>

          <div>
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete="new-password"
              required
              minLength={10}
              value={form.password}
              onChange={set("password")}
            />
            {/* Stated up front because there is no password reset yet — a
                forgotten password currently means a new account. */}
            <FieldHint>
              At least 10 characters. Keep it somewhere safe — password reset is not available
              yet.
            </FieldHint>
          </div>

          <label className="flex items-start gap-2 text-sm text-zinc-300">
            <input
              type="checkbox"
              required
              className="mt-1 h-4 w-4 shrink-0 accent-amber-400"
              checked={agreed}
              onChange={(e) => setAgreed(e.target.checked)}
            />
            <span>
              I agree to the{" "}
              <Link href="/terms" target="_blank" className="text-amber-300 underline">
                Terms of Service
              </Link>{" "}
              and the{" "}
              <Link href="/content-policy" target="_blank" className="text-amber-300 underline">
                Content Policy
              </Link>
              . See how we use your data in the{" "}
              <Link href="/privacy" target="_blank" className="text-amber-300 underline">
                Privacy Policy
              </Link>
              .
            </span>
          </label>

          {error && <p className="text-sm text-red-300">{error}</p>}

          <Button type="submit" className="w-full" disabled={busy || !agreed}>
            {busy ? "Creating account…" : "Create account"}
          </Button>
        </form>
      </Card>

      <p className="mt-6 text-center text-sm text-zinc-400">
        Already have an account?{" "}
        <Link href="/login" className="text-amber-300 hover:underline">
          Log in
        </Link>
      </p>
    </main>
  );
}

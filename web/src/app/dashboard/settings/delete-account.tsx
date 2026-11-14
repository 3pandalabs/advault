"use client";

import { useState } from "react";
import {
  ApiError,
  clearTokens,
  deleteAccount,
  getDeletionPreview,
  type DeletionPreview,
} from "@/lib/api/browser";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

// Self-service account deletion. Google Play requires it in the app, and the
// privacy policy promises it. The API does the work (api/ROUTES.md "Account
// deletion"); this only explains what will happen and asks for the password.
export function DeleteAccountCard() {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<DeletionPreview | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function start() {
    setOpen(true);
    setError(null);
    try {
      setPreview(await getDeletionPreview());
    } catch {
      setError("Could not load your account details. You can still delete it below.");
    }
  }

  async function confirm(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await deleteAccount(password);
      clearTokens();
      setDone(true);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 403
          ? "That password is not right."
          : "Could not delete your account just now. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <Card className="mt-4">
        <CardTitle>Your account is deleted</CardTitle>
        <CardDescription>
          You are signed out. You can sign up again with the same email at any time, as a new
          account.
        </CardDescription>
        <div className="mt-4">
          <Button onClick={() => window.location.assign("/")}>Go to the home page</Button>
        </div>
      </Card>
    );
  }

  const money = (minor: number, currency: string) =>
    new Intl.NumberFormat("en-US", { style: "currency", currency }).format(minor / 100);

  return (
    <Card className="mt-4 border-red-400/20">
      <CardTitle>Delete account</CardTitle>
      <CardDescription>
        Permanently deletes your account. This cannot be undone.
      </CardDescription>

      {!open ? (
        <div className="mt-4">
          <Button variant="outline" onClick={start}>
            Delete my account
          </Button>
        </div>
      ) : (
        <form onSubmit={confirm} className="mt-4 space-y-4">
          <ul className="list-disc space-y-1 pl-5 text-sm text-zinc-300">
            {preview && preview.liveCampaigns > 0 && (
              <li>
                Your {preview.liveCampaigns === 1 ? "running ad stops" : `${preview.liveCampaigns} running ads stop`}{" "}
                now.
              </li>
            )}
            {preview?.activePlan && (
              <li>Your plan ends now, with no further monthly charges. The current month is not refunded.</li>
            )}
            {preview && preview.walletBalanceMinor > 0 && (
              <li>
                Your unused ad budget of {money(preview.walletBalanceMinor, preview.currencyCode)} is
                refunded to your card within 30 days.
              </li>
            )}
            <li>Your sign-in, profile, connected Google accounts and uploaded photos are deleted.</li>
            <li>
              We keep payment records and the ads we made for you, because the law requires us to
              keep financial records. They are no longer linked to your email.
            </li>
          </ul>

          <label className="block text-sm">
            <span className="text-zinc-300">Enter your password to confirm</span>
            <input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 block w-full max-w-sm rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-zinc-100 outline-none focus:border-amber-400"
            />
          </label>

          {error && <p className="text-sm text-red-300">{error}</p>}

          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="destructive" disabled={busy || !password}>
              {busy ? "Deleting…" : "Delete my account permanently"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setOpen(false);
                setPassword("");
                setError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}

"use client";

import { useState } from "react";
import { ApiError, topUp } from "@/lib/api/browser";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { minTopupCents, timesShownEstimate, topupPresets } from "@/lib/budget";
import { formatMoney, parseDollarsToCents } from "@/lib/utils";

/**
 * "Add to your ad budget": $35 / $50 / $100 / custom, with how long it lasts at
 * the daily budget. Top-up-first model (2026-11-19).
 *
 * mode "pay"    — the button starts checkout (wallet page, campaign page).
 * mode "choose" — only picks an amount (the new-campaign wizard, where nothing
 *                 is charged yet); the caller remembers it.
 */
export function TopUpPicker({
  currency,
  campaignId,
  mode = "pay",
  value,
  onChange,
}: {
  currency: string;
  campaignId?: string;
  mode?: "pay" | "choose";
  value?: number;
  onChange?: (cents: number) => void;
}) {
  const presets = topupPresets(currency);
  const min = minTopupCents(currency);
  const [picked, setPicked] = useState<number | "custom">(
    value && !presets.includes(value) ? "custom" : (value ?? presets[1] ?? presets[0]),
  );
  const [custom, setCustom] = useState(value && !presets.includes(value) ? String(value / 100) : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const customCents = parseDollarsToCents(custom);
  const amount = picked === "custom" ? customCents : picked;
  const tooSmall = picked === "custom" && customCents !== null && customCents < min;
  const valid = amount !== null && !tooSmall;

  function choose(next: number | "custom") {
    setPicked(next);
    const cents = next === "custom" ? customCents : next;
    if (cents !== null && cents >= min) onChange?.(cents);
  }

  async function pay() {
    if (!valid || amount === null) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const session = await topUp(amount, campaignId);
      if (session.redirectUrl) {
        window.location.assign(session.redirectUrl);
        return;
      }
      const payload = session.clientPayload as { manual?: boolean; message?: string };
      setNotice(
        payload.manual
          ? (payload.message ?? "Payment is not available yet. Please contact support.")
          : "Opening checkout…",
      );
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === "checkout_failed"
          ? "Could not start checkout. Please try again."
          : err instanceof ApiError && err.code === "topup_below_minimum" && err.detail
            ? err.detail
            : "Something went wrong. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  }


  return (
    <div>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="How much to add">
        {presets.map((p) => (
          <button
            key={p}
            type="button"
            role="radio"
            aria-checked={picked === p}
            disabled={busy}
            onClick={() => choose(p)}
            className={`rounded-lg border px-4 py-2 text-sm font-medium transition ${
              picked === p
                ? "border-amber-400 bg-amber-400/10 text-amber-200"
                : "border-white/10 text-zinc-300 hover:border-white/25"
            }`}
          >
            {formatMoney(p, currency)}
          </button>
        ))}
        <button
          type="button"
          role="radio"
          aria-checked={picked === "custom"}
          disabled={busy}
          onClick={() => choose("custom")}
          className={`rounded-lg border px-4 py-2 text-sm font-medium transition ${
            picked === "custom"
              ? "border-amber-400 bg-amber-400/10 text-amber-200"
              : "border-white/10 text-zinc-300 hover:border-white/25"
          }`}
        >
          Other
        </button>
      </div>

      {picked === "custom" && (
        <div className="mt-3 flex items-center gap-2">
          <Input
            inputMode="decimal"
            className="w-32"
            placeholder={String(min / 100)}
            aria-label="Amount to add"
            value={custom}
            onChange={(e) => {
              setCustom(e.target.value);
              const cents = parseDollarsToCents(e.target.value);
              if (cents !== null && cents >= min) onChange?.(cents);
            }}
          />
          <span className="text-xs text-zinc-400">From {formatMoney(min, currency)}</span>
        </div>
      )}
      {tooSmall && (
        <p className="mt-1.5 text-xs text-red-300">The smallest top-up is {formatMoney(min, currency)}.</p>
      )}

      {valid && amount !== null && (() => {
        // One line, for THIS amount (owner, 2026-11-19): times shown only.
        const est = timesShownEstimate(amount, currency);
        const n = (x: number) => x.toLocaleString("en-US");
        return (
          <p className="mt-3 text-sm text-zinc-300">
            Your ad would be shown about{" "}
            <span key={amount} className="estimate-flash font-semibold text-amber-300">
              {n(est.low)}–{n(est.high)}
            </span>{" "}
            times to people in your area.
          </p>
        );
      })()}

      {mode === "pay" && (
        <div className="mt-4">
          <Button disabled={busy || !valid} onClick={pay}>
            {busy ? "Opening checkout…" : valid ? `Add ${formatMoney(amount!, currency)}` : "Add to my ad budget"}
          </Button>
        </div>
      )}
      {error && <p className="mt-2 text-sm text-red-300">{error}</p>}
      {notice && <p className="mt-2 text-sm text-amber-200">{notice}</p>}
    </div>
  );
}

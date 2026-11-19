"use client";

import { useState } from "react";
import { ApiError, updateCampaign, type Campaign } from "@/lib/api/browser";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { BUDGET_BELOW_MINIMUM_MESSAGE, MAX_DAILY_BUDGET_CENTS, minDailyBudgetCents } from "@/lib/budget";
import { formatMoney, parseDollarsToCents } from "@/lib/utils";

/**
 * The daily budget on the launch card, editable until launch (PATCH refuses a
 * live campaign). Exists for campaigns saved under the old $1/day floor, which
 * Google refuses: they get the plain message and a way to raise it here.
 */
export function BudgetEditor({
  campaign,
  onSaved,
}: {
  campaign: Campaign;
  onSaved: (c: Campaign) => void;
}) {
  const min = minDailyBudgetCents(campaign.currencyCode);
  const below = campaign.dailyBudgetCents < min;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(Math.max(campaign.dailyBudgetCents, min) / 100));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cents = parseDollarsToCents(draft);
  const valid = cents !== null && cents >= min && cents <= MAX_DAILY_BUDGET_CENTS;

  async function save() {
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      onSaved(await updateCampaign(campaign.id, { dailyBudgetCents: cents }));
      setEditing(false);
    } catch (err) {
      setError(
        err instanceof ApiError && err.detail
          ? err.detail
          : err instanceof ApiError && err.code === "campaign_is_live"
            ? "This campaign is live, so its budget can't be changed here."
            : "Could not save. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 text-sm">
      {below && <p className="mb-2 text-amber-200">{BUDGET_BELOW_MINIMUM_MESSAGE}</p>}
      {editing ? (
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="launchDailyBudget" className="text-zinc-300">
            Daily budget ({campaign.currencyCode})
          </label>
          <Input
            id="launchDailyBudget"
            inputMode="decimal"
            className="w-28"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={busy}
          />
          <Button size="sm" disabled={busy || !valid} onClick={save}>
            {busy ? "Saving…" : "Save"}
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(false)}>
            Cancel
          </Button>
          {!valid && (
            <p className="w-full text-xs text-red-300">
              Between {formatMoney(min, campaign.currencyCode)} and{" "}
              {formatMoney(MAX_DAILY_BUDGET_CENTS, campaign.currencyCode)} a day.
            </p>
          )}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2 text-zinc-300">
          <span>
            Daily budget: {formatMoney(campaign.dailyBudgetCents, campaign.currencyCode)}
          </span>
          <Button size="sm" variant={below ? "default" : "ghost"} onClick={() => setEditing(true)}>
            {below ? "Raise budget" : "Change"}
          </Button>
        </div>
      )}
      {error && <p className="mt-2 text-red-300">{error}</p>}
    </div>
  );
}

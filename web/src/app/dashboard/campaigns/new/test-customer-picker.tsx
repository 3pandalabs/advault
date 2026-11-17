"use client";

import { useEffect, useState } from "react";
import {
  ApiError,
  createTestCustomer,
  listTestCustomers,
  switchToTestCustomer,
  type TestCustomer,
} from "@/lib/api/browser";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { FieldHint, Input, Label } from "@/components/ui/input";

// Admin test customers (api routes/testCustomers.ts). Before a new campaign,
// an admin who is testing ("Test as customer" on, or already inside a test
// customer) picks who to test as. Each test customer is a fresh account, so
// the website, ad account and plan start empty. Switching swaps this
// browser's session, then the page reloads as that customer.

/** Query flag set after a switch, so the reloaded wizard doesn't ask again. */
export const CHOSEN_PARAM = "testingAs";

type Choice = { kind: "new" } | { kind: "existing"; id: string };

export function TestCustomerPicker({
  currentName,
  onContinue,
}: {
  /** Set when this session is already inside a test customer. */
  currentName: string | null;
  /** Keep going as the current account (no switch needed). */
  onContinue: () => void;
}) {
  const [customers, setCustomers] = useState<TestCustomer[] | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [choice, setChoice] = useState<Choice>({ kind: "new" });
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listTestCustomers()
      .then((r) => {
        setCustomers(r.customers);
        setCurrent(r.current);
        if (r.current) setChoice({ kind: "existing", id: r.current });
      })
      .catch(() => setCustomers([]));
  }, []);

  async function go() {
    setBusy(true);
    setError(null);
    try {
      if (choice.kind === "existing" && choice.id === current) {
        onContinue();
        return;
      }
      const id = choice.kind === "new" ? (await createTestCustomer(name.trim())).id : choice.id;
      await switchToTestCustomer(id);
      window.location.replace(`/dashboard/campaigns/new?${CHOSEN_PARAM}=1`);
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === "too_many_test_customers"
          ? "You have the most test customers allowed. Pick one from the list."
          : "Couldn't switch. Try again.",
      );
      setBusy(false);
    }
  }

  const others = (customers ?? []).filter((c) => c.id !== current);
  const canGo = choice.kind === "existing" || name.trim().length > 0;

  return (
    <Card>
      <CardTitle>Who are you testing as?</CardTitle>
      <CardDescription>
        Each test customer is a fresh account: no website, ad account or plan yet. Charges are $0.50 and
        launch is a dry run.
      </CardDescription>

      <div className="mt-4 space-y-3 text-sm">
        {current && currentName && (
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="who"
              className="h-4 w-4 accent-amber-400"
              checked={choice.kind === "existing" && choice.id === current}
              onChange={() => setChoice({ kind: "existing", id: current })}
            />
            <span>Continue as {currentName}</span>
          </label>
        )}

        <label className="flex items-center gap-2">
          <input
            type="radio"
            name="who"
            className="h-4 w-4 accent-amber-400"
            checked={choice.kind === "new"}
            onChange={() => setChoice({ kind: "new" })}
          />
          <span>New test customer</span>
        </label>
        {choice.kind === "new" && (
          <div className="ml-6">
            <Label htmlFor="test-customer-name">Business name</Label>
            <Input
              id="test-customer-name"
              value={name}
              maxLength={120}
              placeholder="e.g. Lawn Pros"
              onChange={(e) => setName(e.target.value)}
            />
            <FieldHint>Only you see this. It starts with no website, ad account or plan.</FieldHint>
          </div>
        )}

        {others.map((c) => (
          <label key={c.id} className="flex items-center gap-2">
            <input
              type="radio"
              name="who"
              className="h-4 w-4 accent-amber-400"
              checked={choice.kind === "existing" && choice.id === c.id}
              onChange={() => setChoice({ kind: "existing", id: c.id })}
            />
            <span>{c.name}</span>
          </label>
        ))}
        {customers === null && <p className="text-zinc-500">Loading your test customers…</p>}
      </div>

      {error && <p className="mt-3 text-sm text-red-300">{error}</p>}

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <Button onClick={go} disabled={busy || !canGo}>
          {busy ? "Switching…" : "Continue"}
        </Button>
        {/* The admin's own account in "Test as customer" mode, as before. */}
        {!current && (
          <Button variant="ghost" onClick={onContinue} disabled={busy}>
            Use my own account
          </Button>
        )}
      </div>
    </Card>
  );
}

"use client";

import { useEffect, useState } from "react";
import { getMe, setTestAsCustomer, type Me } from "@/lib/api/browser";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { TEST_PRICE_DISPLAY } from "@/lib/testMode";

// Admin "Test as customer" switch (api: PATCH /auth/me/test-mode, admins only).
// Renders nothing for anyone else. Reloads the page after a switch so every
// screen re-reads prices and gates from the API.
export function TestAsCustomerCard() {
  const [me, setMe] = useState<Me | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getMe().then(setMe).catch(() => undefined);
  }, []);

  if (me?.role !== "admin") return null;
  const on = me.testAsCustomer === true;

  async function toggle() {
    setBusy(true);
    setError(null);
    try {
      await setTestAsCustomer(!on);
      window.location.reload();
    } catch {
      setError("Could not switch test mode. Please try again.");
      setBusy(false);
    }
  }

  return (
    <Card className="mt-4">
      <CardTitle>Test as a customer</CardTitle>
      <CardDescription>
        Use AdVault the way a customer does: you pay for each ad, the website and the plan, and own-video upload is
        closed. Every charge is {TEST_PRICE_DISPLAY}, on your real card. Ad budget top-ups are not test priced. Admin
        pages keep working.
      </CardDescription>
      <Button className="mt-4" variant={on ? "outline" : "default"} onClick={toggle} disabled={busy}>
        {busy ? "Switching…" : on ? "Turn off" : "Turn on"}
      </Button>
      {error ? <p className="mt-2 text-sm text-red-400">{error}</p> : null}
    </Card>
  );
}

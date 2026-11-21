"use client";

import { useEffect, useState } from "react";
import { ApiError, listTestAccounts, setTestAccount, type AdminUser } from "@/lib/api/browser";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

// Accounts marked as test (api migration 0046): ordinary logins that are
// really ours, like the Play Store reviewer's demo account or our own QA.
// They keep signing in and launching exactly as before; marking them only
// keeps them out of customer, revenue and traction numbers. Not the same as
// a test customer made with "Who are you testing as?" (no login, dry runs).
// POST /admin/test-accounts checks the admin role itself.

const ERRORS: Record<string, string> = {
  not_found: "No account with that email. They need to sign up first.",
  test_customer: "That is a test customer. Test customers are already left out.",
  admin_account: "That is an admin. Admins are already left out.",
  admin_role_required: "Your account is no longer an admin.",
};

export function TestAccounts() {
  const [list, setList] = useState<AdminUser[] | null>(null);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    listTestAccounts()
      .then((d) => setList(d.users))
      .catch(() => setList([]));
  }, []);

  async function save(target: string, test: boolean) {
    setBusy(true);
    setNotice(null);
    try {
      const { user } = await setTestAccount(target, test);
      setList((l) => {
        const rest = (l ?? []).filter((u) => u.id !== user.id);
        return user.markedTest ? [...rest, user] : rest;
      });
      setNotice(test ? `${user.email} is now a test user. It can still sign in.` : `${user.email} counts as a real customer again.`);
      if (test) setEmail("");
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "request_failed";
      setNotice(ERRORS[code] ?? `Could not save (${code}).`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mt-10">
      <CardTitle>Test users</CardTitle>
      <CardDescription>
        Our own logins that look like customers, like the Play Store reviewer account. They keep their login and
        work as normal, but are not counted as real customers or revenue.
      </CardDescription>

      <form
        className="mt-4 flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (email.trim()) void save(email.trim(), true);
        }}
      >
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Email"
          className="h-10 w-full max-w-xs rounded-lg border border-white/15 bg-white/5 px-3 text-sm text-zinc-100 placeholder:text-zinc-500"
        />
        <Button type="submit" variant="outline" disabled={busy || !email.trim()}>
          Mark as test user (keeps login)
        </Button>
      </form>

      {notice && <p className="mt-3 text-sm text-amber-100">{notice}</p>}

      <div className="mt-4">
        {!list && <p className="text-sm text-zinc-500">Loading…</p>}
        {list && list.length === 0 && <p className="text-sm text-zinc-500">None yet.</p>}
        {list && list.length > 0 && (
          <ul className="divide-y divide-white/5 text-sm">
            {list.map((u) => (
              <li key={u.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="text-zinc-200">{u.email}</span>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => save(u.email, false)}>
                  Unmark
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

"use client";

import { useEffect, useState } from "react";
import { ApiError, listInternalAccounts, setInternalAccount, type AdminUser } from "@/lib/api/browser";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

// Internal accounts (api migration 0032): 3PandaLabs' own logins that run ads
// for our apps. They pay full price like anyone else; marking them only keeps
// their money out of revenue numbers. POST /admin/internal-accounts checks the
// admin role itself.

const ERRORS: Record<string, string> = {
  not_found: "No account with that email. They need to sign up first.",
  test_customer: "That is a test customer. Test customers are already left out.",
  admin_role_required: "Your account is no longer an admin.",
};

export function InternalAccounts() {
  const [list, setList] = useState<AdminUser[] | null>(null);
  const [email, setEmail] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    listInternalAccounts()
      .then((d) => setList(d.users))
      .catch(() => setList([]));
  }, []);

  async function save(target: string, internal: boolean, withLabel?: string) {
    setBusy(true);
    setNotice(null);
    try {
      const { user } = await setInternalAccount(target, internal, withLabel);
      setList((l) => {
        const rest = (l ?? []).filter((u) => u.id !== user.id);
        return user.isInternal ? [...rest, user] : rest;
      });
      setNotice(internal ? `${user.email} is now internal.` : `${user.email} is a normal customer again.`);
      if (internal) {
        setEmail("");
        setLabel("");
      }
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "request_failed";
      setNotice(ERRORS[code] ?? `Could not save (${code}).`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mt-10">
      <CardTitle>Internal accounts</CardTitle>
      <CardDescription>
        Our own logins that run ads for our apps. They pay full price, but their money is not counted as revenue.
      </CardDescription>

      <form
        className="mt-4 flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (email.trim()) void save(email.trim(), true, label.trim() || undefined);
        }}
      >
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Email"
          className="h-10 w-full max-w-xs rounded-lg border border-white/15 bg-white/5 px-3 text-sm text-zinc-100 placeholder:text-zinc-500"
        />
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Label, e.g. SiteVault"
          maxLength={60}
          className="h-10 w-full max-w-[12rem] rounded-lg border border-white/15 bg-white/5 px-3 text-sm text-zinc-100 placeholder:text-zinc-500"
        />
        <Button type="submit" variant="outline" disabled={busy || !email.trim()}>
          Mark internal
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
                <span>
                  <span className="text-zinc-200">{u.email}</span>
                  {u.internalLabel && <span className="text-zinc-500"> · {u.internalLabel}</span>}
                </span>
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

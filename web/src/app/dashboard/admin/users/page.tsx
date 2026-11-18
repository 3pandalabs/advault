"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ApiError, getMe, listAdminUsers, setUserRole, type AdminUser } from "@/lib/api/browser";
import { Badge, Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { InternalAccounts } from "./internal-accounts";

// Admin-only: find a user and make them an admin, or back to a normal user.
// GET/POST /admin/users enforce admin themselves (re-read from the database);
// this page only hides the UI from others.

const ERRORS: Record<string, string> = {
  own_role: "You can't change your own role. Ask another admin.",
  last_admin: "This is the only admin. Make someone else an admin first.",
  deleted_user: "That account was deleted.",
  same_role: "Nothing to change.",
  not_found: "That user no longer exists.",
  admin_role_required: "Your account is no longer an admin.",
};

export default function AdminUsersPage() {
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [myId, setMyId] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    getMe()
      .then((me) => {
        setAllowed(me.role === "admin");
        setMyId(me.id);
      })
      .catch(() => setAllowed(false));
  }, []);

  useEffect(() => {
    if (!allowed) return;
    let cancelled = false;
    listAdminUsers(search)
      .then((d) => {
        if (cancelled) return;
        setUsers(d.users);
        setError(null);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.code : "request_failed");
      });
    return () => {
      cancelled = true;
    };
  }, [allowed, search]);

  async function change(u: AdminUser, role: AdminUser["role"]) {
    const verb = role === "admin" ? "Make" : "Remove admin from";
    const warn =
      role === "admin"
        ? " Admins make ads and websites for free, skip video review, and can promote other users."
        : "";
    if (!window.confirm(`${verb} ${u.email}?${warn}`)) return;
    setBusy(u.id);
    setNotice(null);
    try {
      const { user } = await setUserRole(u.id, role);
      setUsers((list) => list?.map((x) => (x.id === user.id ? user : x)) ?? null);
      setNotice(
        `${user.email} is now ${user.role === "admin" ? "an admin" : "a normal user"}. It applies after they sign out and back in.`,
      );
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "request_failed";
      setNotice(ERRORS[code] ?? `Could not change the role (${code}).`);
    } finally {
      setBusy(null);
    }
  }

  if (allowed === null) return <p className="text-sm text-zinc-500">Loading…</p>;
  if (!allowed) return <p className="text-sm text-zinc-400">This page is for AdVault admins.</p>;

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Admins</h1>
        <p className="mt-1 text-sm text-zinc-400">
          Find a user and make them an admin. They need to sign up first.{" "}
          <Link href="/dashboard/admin" className="text-amber-300 hover:underline">
            ← Ad performance
          </Link>
        </p>
      </div>

      <form
        className="mb-4 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setSearch(q.trim());
        }}
      >
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Email, name or business"
          className="h-10 w-full max-w-sm rounded-lg border border-white/15 bg-white/5 px-3 text-sm text-zinc-100 placeholder:text-zinc-500"
        />
        <Button type="submit" variant="outline">
          Search
        </Button>
      </form>

      {notice && (
        <p className="mb-4 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-sm text-amber-100">
          {notice}
        </p>
      )}
      {error && (
        <p className="mb-4 rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2 text-sm text-red-200">
          Could not load users ({error}).
        </p>
      )}
      {!users && !error && <p className="text-sm text-zinc-500">Loading…</p>}

      {users && users.length === 0 && (
        <Card>
          <CardTitle>No users found</CardTitle>
          <CardDescription>Check the spelling, or ask them to sign up first.</CardDescription>
        </Card>
      )}

      {users && users.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-white/10">
          <table className="w-full text-left text-sm">
            <thead className="bg-white/[0.03] text-xs tracking-wide text-zinc-500 uppercase">
              <tr>
                <th className="px-3 py-2">User</th>
                <th className="px-3 py-2">Role</th>
                <th className="px-3 py-2">Joined</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {users.map((u) => (
                <tr key={u.id}>
                  <td className="px-3 py-2">
                    <div className="font-medium text-zinc-200">{u.email}</div>
                    <div className="text-xs text-zinc-500">
                      {[u.displayName, u.businessName].filter(Boolean).join(" · ") || "—"}
                      {u.signupApp === "sitevault" ? " · joined via SiteVault" : ""}
                      {u.isInternal ? ` · internal${u.internalLabel ? ` (${u.internalLabel})` : ""}` : ""}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <Badge tone={u.role === "admin" ? "success" : "pending"}>{u.role === "admin" ? "admin" : "user"}</Badge>
                  </td>
                  <td className="px-3 py-2 text-zinc-400">{new Date(u.createdAt).toLocaleDateString()}</td>
                  <td className="px-3 py-2 text-right">
                    {u.id === myId ? (
                      <span className="text-xs text-zinc-500">You</span>
                    ) : u.role === "admin" ? (
                      <Button size="sm" variant="ghost" disabled={busy === u.id} onClick={() => change(u, "advertiser")}>
                        Remove admin
                      </Button>
                    ) : (
                      <Button size="sm" variant="outline" disabled={busy === u.id} onClick={() => change(u, "admin")}>
                        Make admin
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <InternalAccounts />
    </div>
  );
}

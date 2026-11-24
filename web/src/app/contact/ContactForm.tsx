"use client";

import { useEffect, useState } from "react";
import { API_URL, getMe, getTokens } from "@/lib/api/browser";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";

// POST /contact (api/src/routes/contact.ts). Name and email come from the
// account when signed in; a hidden honeypot field catches bots.

const EMPTY = { name: "", email: "", subject: "", message: "", website: "" };

export function ContactForm() {
  const [form, setForm] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  useEffect(() => {
    if (!getTokens().access) return;
    let cancelled = false;
    getMe()
      .then((me) => {
        // What the person already typed wins.
        if (!cancelled) setForm((f) => ({ ...f, name: f.name || me.displayName || me.businessName || "", email: f.email || me.email }));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const set = (key: keyof typeof EMPTY) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // The token only tells us which account wrote; an expired one still sends.
      const token = getTokens().access;
      const res = await fetch(`${API_URL}/contact`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ ...form, website: form.website || undefined }),
      });
      if (res.ok) {
        setSentTo(form.email);
        setForm(EMPTY);
      } else if (res.status === 429) setError("Too many messages right now. Please try again in an hour, or email advault@3pandalabs.com.");
      else if (res.status === 400) setError("Please check your name, email, subject and message.");
      else setError("We couldn't send your message. Please email advault@3pandalabs.com instead.");
    } catch {
      setError("We couldn't send your message. Check your connection, or email advault@3pandalabs.com.");
    } finally {
      setBusy(false);
    }
  }

  if (sentTo) {
    return (
      <p role="status" className="mt-4 rounded-lg border border-emerald-400/30 bg-emerald-400/10 px-4 py-3 text-sm text-emerald-100">
        Thanks, your message was sent. We&apos;ll reply to {sentTo}.
      </p>
    );
  }

  return (
    <form onSubmit={submit} className="relative mt-4 space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="c-name">Name</Label>
          <Input id="c-name" required maxLength={120} autoComplete="name" value={form.name} onChange={set("name")} />
        </div>
        <div>
          <Label htmlFor="c-email">Email</Label>
          <Input id="c-email" type="email" required maxLength={320} autoComplete="email" value={form.email} onChange={set("email")} />
        </div>
      </div>
      <div>
        <Label htmlFor="c-subject">Subject</Label>
        <Input id="c-subject" required maxLength={150} value={form.subject} onChange={set("subject")} />
      </div>
      <div>
        <Label htmlFor="c-message">Question or feedback</Label>
        <Textarea id="c-message" required rows={6} maxLength={4000} value={form.message} onChange={set("message")} />
      </div>
      {/* Honeypot: hidden from people and screen readers; bots fill it in. */}
      <div aria-hidden="true" className="absolute -left-[10000px] h-px w-px overflow-hidden">
        <label htmlFor="c-website">Website</label>
        <input id="c-website" tabIndex={-1} autoComplete="off" value={form.website} onChange={set("website")} />
      </div>
      {error ? (
        <p role="alert" className="text-sm text-red-300">
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={busy}>
        {busy ? "Sending…" : "Send"}
      </Button>
    </form>
  );
}

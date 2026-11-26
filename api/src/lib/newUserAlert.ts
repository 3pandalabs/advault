import type { Message } from "./mailer.js";
import { sendMail, mailerConfigured } from "./mailer.js";

// "<App> New user" email to the org inbox whenever someone signs up
// (2026-11-26, owner request). AdVault and SiteVault share the users table, so
// both sign-up paths land here: POST /auth/register (AdVault) and
// POST /internal/sitevault/accounts (SiteVault). Admin-made test customers
// (routes/testCustomers.ts) are not sign-ups and send nothing.
//
// Fire-and-forget: a mailer failure never fails or delays a sign-up.
// NEW_USER_ALERT_EMAIL overrides the recipient; "off" turns the alert off.

export type SignupApp = "AdVault" | "SiteVault";

/** A SiteVault "lazy move" of an older account passes its original createdAt: not a new sign-up. */
export const BACKFILL_AGE_MS = 24 * 60 * 60 * 1000;

export function isFreshSignup(createdAt: Date | string | null | undefined, now = new Date()): boolean {
  if (createdAt == null) return true;
  const t = new Date(createdAt).getTime();
  return Number.isNaN(t) || now.getTime() - t < BACKFILL_AGE_MS;
}

export function newUserAlertTo(): string | null {
  const v = process.env.NEW_USER_ALERT_EMAIL?.trim();
  if (v?.toLowerCase() === "off") return null;
  return v || "3pandas@3pandalabs.com";
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").trim().slice(0, 200);

export function newUserMail(
  to: string,
  a: { app: SignupApp; email: string; userId: string; businessName?: string | null; businessCategory?: string | null; fromAd?: boolean; at?: Date },
): Message {
  const at = (a.at ?? new Date()).toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const rows: [string, string][] = [
    ["App", a.app],
    ["Email", a.email],
    ...(a.businessName ? ([["Business", oneLine(a.businessName)]] as [string, string][]) : []),
    ...(a.businessCategory ? ([["Category", oneLine(a.businessCategory)]] as [string, string][]) : []),
    ...(a.fromAd ? ([["Came from", "one of our ads"]] as [string, string][]) : []),
    ["Signed up", at],
    ["User id", a.userId],
  ];
  return {
    to,
    from: "advault@3pandalabs.com",
    fromName: `${a.app} sign-ups`,
    subject: `${a.app} New user`,
    text: `New ${a.app} sign-up.\n\n${rows.map(([k, v]) => `${k}: ${v}`).join("\n")}\n`,
    html: `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#1f2937;max-width:560px">
  <p style="font-size:15px"><b>New ${esc(a.app)} sign-up</b></p>
  <table style="font-size:14px;border-collapse:collapse">${rows
    .map(([k, v]) => `<tr><td style="color:#6b7280;padding:2px 12px 2px 0">${esc(k)}</td><td>${esc(v)}</td></tr>`)
    .join("")}</table>
</div>`,
  };
}

/** Sends the alert in the background. Never throws, never awaited by the sign-up. */
export function notifyNewUser(args: Parameters<typeof newUserMail>[1], log: (msg: string) => void): void {
  const to = newUserAlertTo();
  if (!to || !mailerConfigured()) return;
  void sendMail([newUserMail(to, args)], log).catch((err) => log(`new user alert failed: ${String(err)}`));
}

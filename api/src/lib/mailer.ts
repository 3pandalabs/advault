// Outbound email through the shared 3PandaLabs gateway (3pandalabs/mailer, a
// Cloudflare Worker that sends via Resend). The gateway is a dumb transport:
// it holds the only provider credential and the verified sender domain, so no
// Resend/Cloudflare key ever lives in this app's env. Templates stay here.
//
// MAILER_URL / MAILER_TOKEN are read from process.env directly (not env.ts),
// so this module — and the password-reset code that imports it — stays
// reachable in tests without the API's required DATABASE_URL etc., matching how
// routes/sitevaultAuth.ts reads SITEVAULT_INTERNAL_TOKEN.
//
// Fail-soft: an unconfigured or failing send never throws into the caller that
// matters (a password reset still returns 204, the account is untouched). The
// `from` address is chosen by the gateway's APP_SENDERS for `app = "advault"`
// (passwordReset@3pandalabs.com); we only vary the display name per product.

export type Message = {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** One of the gateway's APP_SENDERS for advault; unset = its default (password resets). */
  from?: string;
  fromName?: string;
  replyTo?: string;
};

export type SendResult = { delivered: number; failed: number; skipped: number };

export function mailerConfigured(): boolean {
  return Boolean(process.env.MAILER_URL && process.env.MAILER_TOKEN);
}

export async function sendMail(messages: Message[], log: (msg: string) => void): Promise<SendResult> {
  if (!messages.length) return { delivered: 0, failed: 0, skipped: 0 };
  if (!mailerConfigured()) {
    log(`mailer not configured — ${messages.length} message(s) not delivered`);
    return { delivered: 0, failed: 0, skipped: messages.length };
  }
  const res = await fetch(`${process.env.MAILER_URL!.replace(/\/+$/, "")}/send`, {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.MAILER_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ app: "advault", messages }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`mailer send failed: ${res.status} ${body.slice(0, 300)}`);
  }
  const out = (await res.json().catch(() => ({}))) as { delivered?: number; failed?: number };
  return { delivered: out.delivered ?? messages.length, failed: out.failed ?? 0, skipped: 0 };
}

const escHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * A simple transactional email: an intro line, one call-to-action button to
 * `url`, and an outro. The link is in BOTH the HTML and the text part — an
 * HTML-only message scores worse with spam filters, and some clients show only
 * text.
 */
export function actionMail(
  to: string,
  subject: string,
  intro: string,
  cta: string,
  url: string,
  outro: string,
  fromName?: string,
): Message {
  const html = `<!doctype html><html><body style="margin:0;padding:24px;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#0f172a;line-height:1.5">
  <p>${escHtml(intro)}</p>
  <p><a href="${escHtml(url)}" style="display:inline-block;background:#1e293b;color:#ffffff;padding:11px 22px;border-radius:8px;text-decoration:none;font-weight:700">${escHtml(cta)}</a></p>
  <p style="color:#475569;font-size:14px">${escHtml(outro)}</p>
  <p style="color:#94a3b8;font-size:12px">Or paste this link into your browser:<br>${escHtml(url)}</p>
</body></html>`;
  const text = `${intro}\n\n${cta}: ${url}\n\n${outro}`;
  return { to, subject, html, text, ...(fromName ? { fromName } : {}) };
}

/**
 * A plain notification email: one or more paragraphs, no call-to-action button
 * (e.g. a "your password was changed" security notice). Link(s), if any, go in
 * the paragraph text so they appear in both the HTML and the text part.
 */
export function noticeMail(to: string, subject: string, paragraphs: string[], fromName?: string): Message {
  const html = `<!doctype html><html><body style="margin:0;padding:24px;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#0f172a;line-height:1.5">
  ${paragraphs.map((p) => `<p>${escHtml(p)}</p>`).join("\n  ")}
</body></html>`;
  const text = paragraphs.join("\n\n");
  return { to, subject, html, text, ...(fromName ? { fromName } : {}) };
}

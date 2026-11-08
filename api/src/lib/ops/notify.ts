// Phone alerts for 3PandaLabs operators, through the self-hosted ntfy server
// (ntfy.3pandalabs.com, see 3pandalabs/monitoring). Used for the one manual
// step in platform billing — "add this customer's card in Google Ads" — and
// for money-path failures nobody would otherwise see.
//
// OPS_NTFY_URL is the full topic URL; OPS_NTFY_TOKEN a write-only ntfy access
// token. Unset means alerts are logged and dropped: an alert must never break
// the request that raised it.

const url = process.env.OPS_NTFY_URL;
const token = process.env.OPS_NTFY_TOKEN;

export function isOpsNotifyConfigured(): boolean {
  return Boolean(url);
}

export type OpsAlert = {
  title: string;
  message: string;
  /** ntfy priority 1-5; 4 = high (sound), 5 = urgent. */
  priority?: 1 | 2 | 3 | 4 | 5;
  tags?: string[];
  /** Opened when the notification is tapped. */
  click?: string;
};

/** Returns whether the alert was delivered. Never throws. */
export async function notifyOps(alert: OpsAlert): Promise<boolean> {
  if (!url) {
    console.warn(JSON.stringify({ msg: "ops alert (ntfy not configured)", ...alert }));
    return false;
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        // Header values must be ASCII; the title can carry a business name.
        title: asciiHeader(alert.title),
        priority: String(alert.priority ?? 3),
        ...(alert.tags?.length ? { tags: alert.tags.join(",") } : {}),
        ...(alert.click ? { click: alert.click } : {}),
      },
      body: alert.message,
    });
    if (!res.ok) {
      console.error(JSON.stringify({ msg: "ops alert failed", status: res.status, title: alert.title }));
      return false;
    }
    return true;
  } catch (err) {
    console.error(JSON.stringify({ msg: "ops alert failed", error: String(err), title: alert.title }));
    return false;
  }
}

export function asciiHeader(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[–—]/g, "-")
    .replace(/[^\x20-\x7e]/g, "")
    .slice(0, 200);
}

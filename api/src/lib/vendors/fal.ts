import { notifyOps } from "../ops/notify.js";

// fal account helpers: the credit balance (for the low-balance alert) and an
// immediate page when a fal call fails because the money ran out.
//
// The balance needs a key with billing read access (fal key preset READONLY
// or BILLING): FAL_BILLING_KEY. The generation key (FAL_KEY) can't read it.

export function falBillingConfigured(): boolean {
  return Boolean(process.env.FAL_BILLING_KEY);
}

/** Current fal credit balance, e.g. { balance: 24.5, currency: "USD" }. Throws on failure. */
export async function fetchFalBalance(): Promise<{ balance: number; currency: string }> {
  const res = await fetch("https://api.fal.ai/v1/account/billing?expand=credits", {
    headers: { authorization: `Key ${process.env.FAL_BILLING_KEY}` },
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await res.json().catch(() => ({}))) as {
    credits?: { current_balance?: number; currency?: string };
  };
  if (!res.ok || typeof body.credits?.current_balance !== "number") {
    throw new Error(`fal billing ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
  }
  return { balance: body.credits.current_balance, currency: body.credits.currency ?? "USD" };
}

// fal answers an empty account with an error naming the balance ("Exhausted
// balance", "insufficient credits", a locked user). Every fal call site passes
// its failure here; a match pages ops at once, at most once an hour, instead
// of waiting for the hourly balance check.
const OUT_OF_MONEY = /exhausted balance|insufficient (balance|credit|fund)|user is locked|out of credit|top up|payment required/i;
let lastPagedAt = 0;

export function noteFalFailure(where: string, message: string): void {
  if (!OUT_OF_MONEY.test(message)) return;
  const now = Date.now();
  if (now - lastPagedAt < 3_600_000) return;
  lastPagedAt = now;
  void notifyOps({
    title: "fal.ai is out of credit - AdVault ads are degrading",
    message:
      `A fal call (${where}) failed for lack of balance: ${message.slice(0, 200)}\n\n` +
      "Ads still render, but without motion, the pro photo pass and the ElevenLabs voice until fal is topped up.",
    priority: 5,
    tags: ["rotating_light", "moneybag"],
    click: "https://fal.ai/dashboard/billing",
  });
}

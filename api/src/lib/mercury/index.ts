// Mercury (3PandaLabs' bank) — virtual debit cards for platform-billed
// customers. One card per customer's Google Ads account, so each customer's
// spend has its own hard limit at the bank and its own line on the statement.
//
// What the API can NOT do, and why there is still a human step: it never
// returns a full card number (PAN retrieval is not offered), and Google Ads has
// no API that accepts a card anyway. An operator copies the number from the
// Mercury app into the customer's Google Ads billing page.
//
// Optional: with MERCURY_* unset, no card is created and the operator alert
// says to create one by hand. Nothing else changes.
//
// API reference: https://docs.mercury.com/reference/createcard

const BASE = "https://api.mercury.com/api/v1";

const token = process.env.MERCURY_API_TOKEN;
// The checking account debit cards spend from.
const accountId = process.env.MERCURY_ACCOUNT_ID;
// Mercury requires every card to belong to a team member; ours all belong to
// one operator.
const cardholderUserId = process.env.MERCURY_CARDHOLDER_USER_ID;

export function isMercuryConfigured(): boolean {
  return Boolean(token && accountId && cardholderUserId);
}

export class MercuryApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export type MercuryCard = {
  id: string;
  lastFour: string;
  status: string;
  nickname: string | null;
};

async function call<T>(path: string, body?: unknown): Promise<T> {
  if (!token) throw new MercuryApiError("mercury_not_configured", 0);
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new MercuryApiError(`Mercury ${res.status}: ${text.slice(0, 300)}`, res.status);
  return (text ? JSON.parse(text) : {}) as T;
}

function toCard(raw: { id: string; lastFour: string; status: string; nickname?: string | null }): MercuryCard {
  return { id: raw.id, lastFour: raw.lastFour, status: raw.status, nickname: raw.nickname ?? null };
}

/** Card nicknames show in the Mercury app and on statements. */
export function cardNickname(businessName: string): string {
  return `AdVault – ${businessName}`.slice(0, 60);
}

export async function createCard(args: {
  nickname: string;
  monthlyLimitCents: number;
}): Promise<MercuryCard> {
  const raw = await call<{ id: string; lastFour: string; status: string; nickname?: string }>("/cards", {
    userId: cardholderUserId,
    accountId,
    type: "virtual",
    kind: "debit",
    nickname: args.nickname,
    spendLimit: { amountCents: args.monthlyLimitCents, interval: "monthly" },
  });
  return toCard(raw);
}

export async function setMonthlyLimit(cardId: string, amountCents: number): Promise<MercuryCard> {
  return toCard(
    await call(`/cards/${cardId}`, {
      spendLimit: { amountCents, interval: "monthly", atmAmountCents: null },
    }),
  );
}

export async function freezeCard(cardId: string): Promise<void> {
  await call(`/cards/${cardId}/freeze`);
}

export async function unfreezeCard(cardId: string): Promise<void> {
  await call(`/cards/${cardId}/unfreeze`);
}

/** Permanent. Mercury cannot reactivate a cancelled card. */
export async function cancelCard(cardId: string): Promise<void> {
  await call(`/cards/${cardId}/cancel`);
}

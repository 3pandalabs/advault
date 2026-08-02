import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { ledgerEntries, wallets } from "../../db/schema.js";
import type { Currency } from "../pricing/index.js";

// The only module allowed to move money.
//
// Every mutation writes a ledger row AND updates the denormalised balance in
// ONE transaction. The ledger is the source of truth; `wallets.balance_minor`
// is a cache that exists so the launch guard doesn't run an aggregate on the
// hot path. If those two ever disagree, the ledger is right — see reconcile().
//
// Nothing here is exported as a raw balance write. There is no setBalance().

export type LedgerType = "topup" | "spend" | "fee" | "refund" | "adjustment";

export async function ensureWallet(userId: string, currency: Currency) {
  const [existing] = await db.select().from(wallets).where(eq(wallets.userId, userId)).limit(1);
  if (existing) return existing;

  const [created] = await db
    .insert(wallets)
    .values({ userId, currencyCode: currency, balanceMinor: 0 })
    // A concurrent signup + first payment can race here; the unique index on
    // user_id makes the loser a no-op rather than an error.
    .onConflictDoNothing({ target: wallets.userId })
    .returning();
  if (created) return created;

  const [after] = await db.select().from(wallets).where(eq(wallets.userId, userId)).limit(1);
  return after;
}

export class InsufficientFunds extends Error {
  constructor(
    readonly balanceMinor: number,
    readonly requiredMinor: number,
  ) {
    super("insufficient_funds");
  }
}

export class DuplicateLedgerEntry extends Error {
  constructor(readonly externalRef: string) {
    super("duplicate_ledger_entry");
  }
}

/**
 * Applies a signed amount to a wallet and records it.
 *
 * `externalRef` is the idempotency key and should ALWAYS be supplied for money
 * arriving from outside — a provider payment id, or a `campaign:date` key for a
 * spend sync. The partial unique index on (wallet_id, external_ref) turns a
 * replayed webhook or a re-run sync into a caught duplicate instead of a
 * double credit. Payment webhooks retry by design; this is the thing standing
 * between "Razorpay retried" and "we credited them twice".
 */
export async function applyEntry(args: {
  userId: string;
  currency: Currency;
  type: LedgerType;
  amountMinor: number;
  description?: string;
  campaignId?: string | null;
  externalRef?: string | null;
  /** Debits normally floor at zero; pass true to let a spend overshoot. */
  allowOverdraft?: boolean;
}): Promise<{ balanceMinor: number }> {
  const wallet = await ensureWallet(args.userId, args.currency);

  return db.transaction(async (tx) => {
    // Lock the row first: two concurrent debits that both read the old balance
    // would each individually pass the funds check and together overdraw.
    const [locked] = await tx
      .select()
      .from(wallets)
      .where(eq(wallets.id, wallet.id))
      .for("update");

    const next = locked.balanceMinor + args.amountMinor;

    if (next < 0 && !args.allowOverdraft) {
      throw new InsufficientFunds(locked.balanceMinor, Math.abs(args.amountMinor));
    }

    try {
      await tx.insert(ledgerEntries).values({
        walletId: wallet.id,
        type: args.type,
        amountMinor: args.amountMinor,
        currencyCode: args.currency,
        description: args.description,
        campaignId: args.campaignId ?? null,
        externalRef: args.externalRef ?? null,
      });
    } catch (err) {
      // 23505 on the (wallet_id, external_ref) index means we have already
      // applied this exact external event. Not an error condition — the caller
      // treats it as success and returns the current balance.
      if ((err as { code?: string }).code === "23505" && args.externalRef) {
        throw new DuplicateLedgerEntry(args.externalRef);
      }
      throw err;
    }

    // Clamped at zero when overdraft is allowed, so the CHECK constraint holds
    // even when Google reports more spend than the advertiser had left. The
    // ledger still records the true amount — the shortfall is visible as the
    // gap between the ledger sum and the balance, which is exactly what
    // reconcile() surfaces.
    const applied = Math.max(next, 0);
    await tx
      .update(wallets)
      .set({ balanceMinor: applied, updatedAt: new Date() })
      .where(eq(wallets.id, wallet.id));

    return { balanceMinor: applied };
  });
}

export async function getBalance(userId: string): Promise<{
  balanceMinor: number;
  currencyCode: string;
} | null> {
  const [w] = await db
    .select({ balanceMinor: wallets.balanceMinor, currencyCode: wallets.currencyCode })
    .from(wallets)
    .where(eq(wallets.userId, userId))
    .limit(1);
  return w ?? null;
}

/**
 * Can this advertiser afford to have a campaign live?
 *
 * Requires the balance to cover at least MIN_FUNDED_DAYS of the daily budget
 * rather than a single day. One day's cover would mean the nightly sync always
 * arrives after the money is gone — the guard has to lead the spend, not trail
 * it, because Google will keep serving until we pause it.
 */
export const MIN_FUNDED_DAYS = 3;

export async function canLaunch(
  userId: string,
  dailyBudgetMinor: number,
): Promise<{ ok: true } | { ok: false; balanceMinor: number; requiredMinor: number }> {
  const w = await getBalance(userId);
  const required = dailyBudgetMinor * MIN_FUNDED_DAYS;
  const balance = w?.balanceMinor ?? 0;
  return balance >= required ? { ok: true } : { ok: false, balanceMinor: balance, requiredMinor: required };
}

/**
 * Recomputes the balance from the ledger. The ledger is authoritative, so this
 * is the repair tool when the cached balance drifts — and the audit that proves
 * it hasn't. Reports rather than silently fixing when `apply` is false.
 */
export async function reconcile(userId: string, apply = false) {
  const [w] = await db.select().from(wallets).where(eq(wallets.userId, userId)).limit(1);
  if (!w) return null;

  const [{ total }] = await db
    .select({ total: sql<number>`coalesce(sum(${ledgerEntries.amountMinor}), 0)::int` })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.walletId, w.id));

  // Floored, because allowOverdraft debits clamp the cached balance at zero.
  const expected = Math.max(total, 0);
  const drift = w.balanceMinor - expected;

  if (drift !== 0 && apply) {
    await db
      .update(wallets)
      .set({ balanceMinor: expected, updatedAt: new Date() })
      .where(eq(wallets.id, w.id));
  }

  return { cached: w.balanceMinor, ledgerSum: total, expected, drift, applied: drift !== 0 && apply };
}

export async function listEntries(userId: string, limit = 50) {
  return db
    .select({
      id: ledgerEntries.id,
      type: ledgerEntries.type,
      amountMinor: ledgerEntries.amountMinor,
      currencyCode: ledgerEntries.currencyCode,
      description: ledgerEntries.description,
      campaignId: ledgerEntries.campaignId,
      createdAt: ledgerEntries.createdAt,
    })
    .from(ledgerEntries)
    .innerJoin(wallets, eq(ledgerEntries.walletId, wallets.id))
    .where(and(eq(wallets.userId, userId)))
    .orderBy(sql`${ledgerEntries.createdAt} desc`)
    .limit(limit);
}

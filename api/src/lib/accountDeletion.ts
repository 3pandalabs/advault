import { randomBytes } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { markUserDeleted } from "../auth/deleted.js";
import { hashSecret } from "../auth/password.js";
import { db } from "../db/index.js";
import { adAccounts, assets, campaigns, sessions, subscriptions, users, wallets, youtubeChannels } from "../db/schema.js";
import { deleteObject } from "../plugins/r2.js";
import { isMccConfigured, mccAccessToken, pauseCampaign } from "./googleAds/mcc.js";
import { notifyOps } from "./ops/notify.js";

// Self-service account deletion (api/ROUTES.md "Account deletion"). Google
// Play requires an in-app way to delete an account.
//
// The user row is anonymised rather than deleted: payments, purchases,
// invoices, campaigns and the wallet ledger cascade from it, and those are the
// financial records we have to keep. What goes:
//   - sign-in: email → a tombstone address, password → an unusable hash, every
//     session deleted (refresh fails at once; access tokens are refused by
//     requireAuth (auth/deleted.ts) and expire within 15 minutes anyway);
//   - profile: name, business name, category, phone;
//   - Google grants: YouTube channel rows and brought-your-own Google Ads rows
//     (with their encrypted refresh tokens). AdVault-managed accounts stay:
//     they are our MCC's children and carry our Mercury card;
//   - uploaded photos and logos: rows and R2 objects.
// Live campaigns are paused at Google first, the plan is cancelled
// immediately, and ops get one alert listing the manual clean-up (Mercury
// card, any wallet refund, any campaign Google refused to pause).

export const DELETED_NAME = "Deleted user";

export function tombstoneEmail(userId: string): string {
  // .invalid is a reserved TLD, so the address can never receive mail, and it
  // is unique per user so the users.email unique index stays satisfied.
  return `deleted+${userId}@advault.invalid`;
}

export type DeletionPreview = {
  liveCampaigns: number;
  activePlan: boolean;
  walletBalanceMinor: number;
  currencyCode: string;
};

/** What deleting would do, for the confirmation screen. */
export async function deletionPreview(userId: string): Promise<DeletionPreview> {
  const [[live], [plan], [wallet], [user]] = await Promise.all([
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(campaigns)
      .where(and(eq(campaigns.userId, userId), eq(campaigns.status, "live"))),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(subscriptions)
      .where(and(eq(subscriptions.userId, userId), inArray(subscriptions.status, ["pending", "active", "past_due"]))),
    db.select({ balanceMinor: wallets.balanceMinor }).from(wallets).where(eq(wallets.userId, userId)).limit(1),
    db.select({ currencyCode: users.currencyCode }).from(users).where(eq(users.id, userId)).limit(1),
  ]);
  return {
    liveCampaigns: live?.n ?? 0,
    activePlan: (plan?.n ?? 0) > 0,
    walletBalanceMinor: wallet?.balanceMinor ?? 0,
    currencyCode: user?.currencyCode ?? "USD",
  };
}

export type DeleteResult = { ok: true } | { ok: false; reason: "already_deleted" };

export async function deleteAccount(userId: string): Promise<DeleteResult> {
  const [before] = await db
    .select({ email: users.email, deletedAt: users.deletedAt })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!before || before.deletedAt) return { ok: false, reason: "already_deleted" };

  // 1. Stop the spend first, outside the transaction (network calls). Best
  // effort, like the offer-expiry sweep: a campaign Google won't pause is
  // still flipped to paused locally and named in the ops alert.
  const live = await db
    .select({
      id: campaigns.id,
      businessName: campaigns.businessName,
      customerId: campaigns.googleCustomerId,
      resourceName: campaigns.googleCampaignResourceName,
    })
    .from(campaigns)
    .where(and(eq(campaigns.userId, userId), eq(campaigns.status, "live")));
  const notPaused: string[] = [];
  if (live.length) {
    const token = isMccConfigured() ? await mccAccessToken().catch(() => null) : null;
    for (const c of live) {
      try {
        if (!token || !c.customerId || !c.resourceName) throw new Error("no Google access");
        await pauseCampaign({ accessToken: token, customerId: c.customerId, campaignResourceName: c.resourceName });
      } catch {
        notPaused.push(`${c.businessName} (${c.customerId ?? "no customer id"})`);
      }
    }
  }

  const unusableHash = await hashSecret(randomBytes(32).toString("hex"));
  const now = new Date();

  const result = await db.transaction(async (tx) => {
    const locked = await tx.execute(sql`select deleted_at from users where id = ${userId} for update`);
    const row = locked.rows[0] as { deleted_at: Date | null } | undefined;
    if (!row || row.deleted_at) return null;

    await tx
      .update(campaigns)
      .set({ status: "paused", updatedAt: now })
      .where(and(eq(campaigns.userId, userId), eq(campaigns.status, "live")));
    await tx
      .update(subscriptions)
      .set({ status: "canceled", canceledAt: now, cancelAtPeriodEnd: false, updatedAt: now })
      .where(and(eq(subscriptions.userId, userId), inArray(subscriptions.status, ["pending", "active", "past_due"])));

    await tx.delete(sessions).where(eq(sessions.userId, userId));
    await tx.delete(youtubeChannels).where(eq(youtubeChannels.userId, userId));
    await tx.delete(adAccounts).where(and(eq(adAccounts.userId, userId), eq(adAccounts.isManaged, false)));
    const managed = await tx
      .select({ customerId: adAccounts.customerId })
      .from(adAccounts)
      .where(and(eq(adAccounts.userId, userId), eq(adAccounts.isManaged, true)));
    const gone = await tx.delete(assets).where(eq(assets.userId, userId)).returning({ key: assets.r2Key });
    const [wallet] = await tx
      .select({ balanceMinor: wallets.balanceMinor, currencyCode: wallets.currencyCode })
      .from(wallets)
      .where(eq(wallets.userId, userId))
      .limit(1);

    await tx
      .update(users)
      .set({
        email: tombstoneEmail(userId),
        passwordHash: unusableHash,
        displayName: DELETED_NAME,
        businessName: null,
        businessCategory: null,
        phone: null,
        deletedAt: now,
      })
      .where(and(eq(users.id, userId), isNull(users.deletedAt)));

    return { keys: gone.map((g) => g.key), managed, wallet };
  });
  if (!result) return { ok: false, reason: "already_deleted" };
  markUserDeleted(userId);

  // 2. After commit: object deletes and the ops alert never undo the deletion.
  await Promise.all(result.keys.map((k) => deleteObject(k).catch(() => undefined)));

  const lines = [`User ${userId} (was ${before.email}) deleted their account.`];
  if (result.managed.length) {
    lines.push(
      `Managed Google Ads account(s) ${result.managed.map((m) => m.customerId ?? "pending").join(", ")}: freeze or cancel their Mercury card.`,
    );
  }
  if (result.wallet && result.wallet.balanceMinor > 0) {
    lines.push(`Refund wallet balance ${(result.wallet.balanceMinor / 100).toFixed(2)} ${result.wallet.currencyCode}.`);
  }
  if (notPaused.length) lines.push(`PAUSE BY HAND, Google refused: ${notPaused.join("; ")}.`);
  lines.push("Their videos on AdVault's YouTube channel stay up until removed.");
  await notifyOps({
    title: "AdVault account deleted",
    message: lines.join("\n"),
    priority: notPaused.length || (result.wallet?.balanceMinor ?? 0) > 0 ? 4 : 3,
    tags: ["wastebasket"],
  });

  return { ok: true };
}

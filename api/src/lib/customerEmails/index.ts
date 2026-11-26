// Customer emails: the DB half (who, once-only claims) and the send. Templates
// in templates.ts, pure rules in policy.ts. CLAUDE.md "Customer emails".
//
// Every entry point is fire-and-forget: it returns void (or a promise that
// never rejects), never throws into the request or job that triggered it, and
// a failure only logs. Nothing is claimed or sent when the mailer is not
// configured. The gateway quota for app "advault" is shared with password
// resets, the contact form and the new-user alert.
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "../../db/index.js";
import { adAccounts, campaigns, creatives, users } from "../../db/schema.js";
import { mailerConfigured, sendMail, type Message } from "../mailer.js";
import { formatMinor, type Currency } from "../pricing/index.js";
import { adReadyDecision, customerEmailSkip, webOrigin } from "./policy.js";
import { adAccountReadyMail, adReadyMail, lowBudgetMail, welcomeMail } from "./templates.js";

type Log = (msg: string) => void;
const defaultLog: Log = (m) => console.warn(JSON.stringify({ msg: m }));

type Recipient = { email: string; name: string | null };

async function recipientFor(userId: string, log: Log, what: string): Promise<Recipient | null> {
  const [u] = await db
    .select({
      email: users.email,
      role: users.role,
      deletedAt: users.deletedAt,
      testOwnerId: users.testOwnerId,
      displayName: users.displayName,
      businessName: users.businessName,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!u) return null;
  const skip = customerEmailSkip(u);
  if (skip) {
    log(`customer email "${what}" not sent: ${skip}`);
    return null;
  }
  return { email: u.email, name: u.displayName ?? u.businessName ?? null };
}

async function deliver(message: Message, log: Log, what: string): Promise<void> {
  try {
    const r = await sendMail([message], log);
    if (r.failed) log(`customer email "${what}" failed at the gateway`);
  } catch (err) {
    log(`customer email "${what}" failed: ${String(err)}`);
  }
}

/** Runs `job` in the background; any error is logged, never thrown. */
function background(job: () => Promise<void>, log: Log, what: string): void {
  if (!mailerConfigured()) return;
  void job().catch((err) => log(`customer email "${what}" threw: ${String(err)}`));
}

// ---------------------------------------------------------------------------
// 1. Welcome — POST /auth/register, beside notifyNewUser.
// ---------------------------------------------------------------------------
export function sendWelcomeEmail(
  u: { email: string; role: string; displayName?: string | null; businessName?: string | null },
  log: Log = defaultLog,
): void {
  if (!mailerConfigured()) return;
  const skip = customerEmailSkip({ email: u.email, role: u.role, deletedAt: null, testOwnerId: null });
  if (skip) return log(`customer email "welcome" not sent: ${skip}`);
  const msg = welcomeMail(u.email, { origin: webOrigin(), name: u.displayName ?? u.businessName ?? null });
  void deliver(msg, log, "welcome");
}

// ---------------------------------------------------------------------------
// 2. Ad account ready — platform billing pending -> active.
// ---------------------------------------------------------------------------

/** Claims the once-only mark. True = this caller sends. */
export async function claimAdAccountReady(accountId: string): Promise<boolean> {
  const rows = await db
    .update(adAccounts)
    .set({ readyEmailedAt: new Date() })
    .where(and(eq(adAccounts.id, accountId), isNull(adAccounts.readyEmailedAt)))
    .returning({ id: adAccounts.id });
  return rows.length > 0;
}

export async function adAccountReadyNow(account: { id: string; userId: string }, log: Log = defaultLog): Promise<void> {
  if (!mailerConfigured()) return;
  if (!(await claimAdAccountReady(account.id))) return;
  const to = await recipientFor(account.userId, log, "ad account ready");
  if (!to) return;
  // Link to the newest campaign not yet launched; else the dashboard.
  const [c] = await db
    .select({ id: campaigns.id, name: campaigns.name })
    .from(campaigns)
    .where(and(eq(campaigns.userId, account.userId), isNull(campaigns.googleCampaignResourceName)))
    .orderBy(desc(campaigns.createdAt))
    .limit(1);
  await deliver(adAccountReadyMail(to.email, { origin: webOrigin(), name: to.name, campaign: c ?? null }), log, "ad account ready");
}

export function notifyAdAccountReady(account: { id: string; userId: string }, log: Log = defaultLog): void {
  background(() => adAccountReadyNow(account, log), log, "ad account ready");
}

// ---------------------------------------------------------------------------
// 3. Your ad is ready — after a creative lands on YouTube.
// ---------------------------------------------------------------------------

export async function adReadyNow(creativeId: string, log: Log = defaultLog): Promise<void> {
  if (!mailerConfigured()) return;
  const [c] = await db
    .select({
      campaignId: creatives.campaignId,
      kind: creatives.kind,
      version: creatives.version,
      purchaseId: creatives.purchaseId,
      offerChangeId: creatives.offerChangeId,
    })
    .from(creatives)
    .where(eq(creatives.id, creativeId))
    .limit(1);
  // Offer-change re-cuts, base cuts and uploads (admin uploads, reviewed
  // customer uploads, "Made from your video" copies) send nothing.
  if (!c || c.offerChangeId || (c.kind !== "standard" && c.kind !== "cinematic")) return;

  const make = await db
    .select({
      id: creatives.id,
      createdAt: creatives.createdAt,
      renderStatus: creatives.renderStatus,
      youtubeVideoId: creatives.youtubeVideoId,
      youtubeUploadStatus: creatives.youtubeUploadStatus,
      reviewStatus: creatives.reviewStatus,
      readyEmailedAt: creatives.readyEmailedAt,
    })
    .from(creatives)
    .where(
      and(
        eq(creatives.campaignId, c.campaignId),
        eq(creatives.kind, c.kind),
        eq(creatives.version, c.version),
        isNull(creatives.offerChangeId),
        c.purchaseId ? eq(creatives.purchaseId, c.purchaseId) : isNull(creatives.purchaseId),
      ),
    );
  const decision = adReadyDecision(make);
  if (!decision.send) return;
  // The claim: one row, atomic, so two upload workers finishing the two
  // formats at once still send one email.
  const claimed = await db
    .update(creatives)
    .set({ readyEmailedAt: new Date() })
    .where(and(eq(creatives.id, decision.anchorId), isNull(creatives.readyEmailedAt)))
    .returning({ id: creatives.id });
  if (claimed.length === 0) return;

  const [campaign] = await db
    .select({
      id: campaigns.id,
      name: campaigns.name,
      businessName: campaigns.businessName,
      userId: campaigns.userId,
      complianceStatus: campaigns.complianceStatus,
    })
    .from(campaigns)
    .where(eq(campaigns.id, c.campaignId))
    .limit(1);
  if (!campaign || campaign.complianceStatus === "taken_down") return;
  const to = await recipientFor(campaign.userId, log, "ad ready");
  if (!to) return;
  await deliver(adReadyMail(to.email, { origin: webOrigin(), name: to.name, campaign }), log, "ad ready");
}

export function notifyAdReady(creativeId: string, log: Log = defaultLog): void {
  background(() => adReadyNow(creativeId, log), log, "ad ready");
}

// ---------------------------------------------------------------------------
// 4. Low ad budget — render/spendSync.ts, at the same moment as the ops ping
//    and under the same once-per-episode mark (campaigns.low_balance_alerted_at).
// ---------------------------------------------------------------------------

export async function lowBudgetNow(
  a: {
    userId: string;
    balanceMinor: number;
    dailyMinor: number;
    currency: Currency;
    daysLeft: number;
    campaigns: { id: string; name: string }[];
  },
  log: Log = defaultLog,
): Promise<void> {
  if (!mailerConfigured()) return;
  const to = await recipientFor(a.userId, log, "low budget");
  if (!to) return;
  const msg = lowBudgetMail(to.email, {
    origin: webOrigin(),
    name: to.name,
    balance: formatMinor(a.balanceMinor, a.currency),
    daily: formatMinor(a.dailyMinor, a.currency),
    daysLeft: a.daysLeft,
    campaign: a.campaigns.length === 1 ? a.campaigns[0]! : null,
  });
  await deliver(msg, log, "low budget");
}

export function notifyLowBudget(a: Parameters<typeof lowBudgetNow>[0], log: Log = defaultLog): void {
  background(() => lowBudgetNow(a, log), log, "low budget");
}

import { and, desc, eq, gte, lt } from "drizzle-orm";
import { db } from "../db/index.js";
import { vendorBalanceSnapshots } from "../db/schema.js";
import { notifyOps } from "../lib/ops/notify.js";
import { falBillingConfigured, fetchFalBalance } from "../lib/vendors/fal.js";
import { WINDOW_DAYS, assess, dailyBurn, shouldAlert, type Level } from "../lib/vendors/balancePolicy.js";

// Hourly fal balance check (renderer; outside RENDER_CONCURRENCY, it is one
// HTTP call). Records the balance, sizes the threshold from the recent spend
// rate (lib/vendors/balancePolicy.ts) and pages ops via ntfy when it is low.
// Off unless FAL_BILLING_KEY is set.

const INTERVAL_MS = Number(process.env.FAL_BALANCE_INTERVAL_MS ?? 3_600_000);
const VENDOR = "fal";

function log(msg: string, extra?: unknown): void {
  console.log(JSON.stringify({ job: "fal-balance", msg, extra }));
}

const usd = (v: number) => `$${v.toFixed(2)}`;

export async function checkFalBalance(): Promise<void> {
  const { balance, currency } = await fetchFalBalance();
  const now = new Date();
  const since = new Date(now.getTime() - WINDOW_DAYS * 86_400_000);

  const history = await db
    .select()
    .from(vendorBalanceSnapshots)
    .where(and(eq(vendorBalanceSnapshots.vendor, VENDOR), gte(vendorBalanceSnapshots.takenAt, since)))
    .orderBy(desc(vendorBalanceSnapshots.takenAt));
  const [lastAlert] = await db
    .select({ at: vendorBalanceSnapshots.takenAt })
    .from(vendorBalanceSnapshots)
    .where(and(eq(vendorBalanceSnapshots.vendor, VENDOR), eq(vendorBalanceSnapshots.alerted, true)))
    .orderBy(desc(vendorBalanceSnapshots.takenAt))
    .limit(1);

  const readings = [
    ...history.map((h) => ({ balance: h.balanceMicros / 1e6, at: h.takenAt })),
    { balance, at: now },
  ];
  const a = assess(balance, dailyBurn(readings, now));
  const previous = history[0] ? { level: history[0].alertLevel as Level, lastAlertAt: lastAlert?.at ?? null } : null;
  const why = shouldAlert(a.level, previous, now);

  let alerted = false;
  if (why) {
    const rate = a.burnPerDay ? `Spending about ${usd(a.burnPerDay)}/day` : "No spend measured yet";
    const runway = a.runwayDays !== null ? `, about ${a.runwayDays} days left` : "";
    alerted = await notifyOps(
      why === "recovered"
        ? {
            title: `fal.ai topped up: ${usd(balance)}`,
            message: `Balance is back above the alert line (${usd(a.threshold)}). ${rate}${runway}.`,
            priority: 2,
            tags: ["white_check_mark"],
          }
        : {
            title: `fal.ai balance ${a.level === "critical" ? "CRITICAL" : "low"}: ${usd(balance)}`,
            message:
              `${rate}${runway}. Alert line ${usd(a.threshold)} (7 days of spend, min $5); critical under ${usd(a.critical)}.\n` +
              "When it runs out, AdVault ads lose motion, the pro photo pass and the ElevenLabs voice. Top up at fal.ai.",
            priority: a.level === "critical" ? 5 : 4,
            tags: ["moneybag", a.level === "critical" ? "rotating_light" : "warning"],
            click: "https://fal.ai/dashboard/billing",
          },
    );
  }

  await db.insert(vendorBalanceSnapshots).values({
    vendor: VENDOR,
    balanceMicros: Math.round(balance * 1e6),
    currencyCode: currency,
    alertLevel: a.level,
    alerted,
    takenAt: now,
  });
  // Keep 90 days; the rule only looks at the last 14.
  await db
    .delete(vendorBalanceSnapshots)
    .where(and(eq(vendorBalanceSnapshots.vendor, VENDOR), lt(vendorBalanceSnapshots.takenAt, new Date(now.getTime() - 90 * 86_400_000))));

  log("checked", { balance, ...a, alert: why, alerted });
}

export function startFalBalanceWatch(): void {
  if (!falBillingConfigured()) {
    log("FAL_BILLING_KEY unset; fal balance alert off");
    return;
  }
  const tick = () => checkFalBalance().catch((err) => log("check failed", String(err)));
  void tick();
  setInterval(tick, INTERVAL_MS).unref();
}

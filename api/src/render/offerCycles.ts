import {
  campaignsPastOfferExpiry,
  cyclesNeedingAttention,
  markOfferExpired,
  openCyclesForEntitledSubscribers,
  sendPrompt,
  sendReminder,
  skipCycle,
} from "../lib/offers/index.js";
import { nextCycleAction, type CycleStatus } from "../lib/offers/policy.js";
import { dueForRenewal, openNextInvoice, sweepCancellations } from "../lib/subscriptions/index.js";
import { isMccConfigured, mccAccessToken, pauseCampaign } from "../lib/googleAds/mcc.js";
import { isWhatsAppConfigured } from "../lib/whatsapp/index.js";

// Three periodic sweeps, all in the renderer container for the same reason
// spendSync is: it is already a long-lived process, so they need no new
// deployment, and running them in the API would fire each one once per replica.
//
//   1. The monthly offer conversation — open a cycle per subscriber, prompt,
//      remind, give up.
//   2. Subscription renewals — open the next period's invoice.
//   3. Offer expiry — pause campaigns whose deadline has passed.
//
// Every one of them is idempotent at the database level rather than by being
// careful about timing: `uq_offer_cycles_user_month` and `uq_sub_invoices_period`
// mean a double run is a caught duplicate, not a second WhatsApp message to a
// real person or a second charge to a real card.

const INTERVAL_MS = Number(process.env.OFFER_SWEEP_INTERVAL_MS ?? 60 * 60 * 1000);

function log(msg: string, extra?: unknown): void {
  console.log(JSON.stringify({ job: "offer-cycles", msg, extra: extra ?? undefined }));
}

export async function runOfferCycleSweep(now = new Date()) {
  const stats = { opened: 0, prompted: 0, reminded: 0, skipped: 0 };

  // Opened regardless of whether WhatsApp is configured: the dashboard fallback
  // works off the same cycle rows, so an unconfigured channel must not mean no
  // monthly cycle at all.
  stats.opened = await openCyclesForEntitledSubscribers(now);

  if (!isWhatsAppConfigured()) {
    log("WhatsApp not configured — cycles opened, no messages sent", stats);
    return stats;
  }

  for (const cycle of await cyclesNeedingAttention()) {
    const action = nextCycleAction({
      status: cycle.status as CycleStatus,
      promptedAt: cycle.promptedAt,
      reminderCount: cycle.reminderCount,
      now,
    });

    try {
      switch (action.action) {
        case "prompt": {
          const r = await sendPrompt(cycle.id, now);
          if (r.sent) stats.prompted += 1;
          break;
        }
        case "remind": {
          const r = await sendReminder(cycle.id, action.reminderNumber, now);
          if (r.sent) stats.reminded += 1;
          break;
        }
        case "skip":
          await skipCycle(cycle.id, now);
          stats.skipped += 1;
          break;
        case "wait":
          break;
      }
    } catch (err) {
      // One customer's failure must not stop the sweep for everyone else — a
      // single bad phone number would otherwise silence the whole channel.
      log("cycle action failed", { cycleId: cycle.id, error: String(err) });
    }
  }

  return stats;
}

export async function runRenewalSweep(now = new Date()) {
  const canceled = await sweepCancellations(now);
  let opened = 0;

  // Opening the invoice is all this does. The provider charges the mandate on
  // its own schedule and tells us through the webhook; this row exists so the
  // payment has something to land on, and so a subscription whose provider has
  // gone quiet is visible as an unpaid period rather than as nothing at all.
  for (const sub of await dueForRenewal(now)) {
    try {
      if (await openNextInvoice(sub.id, now)) opened += 1;
    } catch (err) {
      log("failed to open renewal invoice", { subscriptionId: sub.id, error: String(err) });
    }
  }

  return { canceled, opened };
}

/**
 * Pauses campaigns whose offer deadline has passed.
 *
 * The deadline is the point of the whole product: a "Diwali special" still
 * serving in December burns the advertiser's budget sending people to a deal
 * the shop will not honour, and damages them more than not advertising at all.
 * Nothing at Google expires an ad for us.
 *
 * The local status is flipped even when Google cannot be reached, and
 * deliberately so — the alternative is retrying forever against an account we
 * may no longer have credentials for, while the ad keeps serving. A campaign
 * marked paused here that is still live at Google shows up as spend against a
 * paused campaign in the next spendSync, which is a visible, investigable
 * discrepancy rather than a silent one.
 */
export async function runOfferExpirySweep(now = new Date()) {
  const due = await campaignsPastOfferExpiry(now);
  if (due.length === 0) return { expired: 0, pausedAtGoogle: 0 };

  let pausedAtGoogle = 0;
  const mccReady = isMccConfigured();
  const token = mccReady ? await mccAccessToken().catch(() => null) : null;

  for (const campaign of due) {
    if (token && campaign.googleCampaignResourceName && campaign.googleCustomerId) {
      try {
        await pauseCampaign({
          accessToken: token,
          customerId: campaign.googleCustomerId,
          campaignResourceName: campaign.googleCampaignResourceName,
        });
        pausedAtGoogle += 1;
      } catch (err) {
        log("failed to pause an expired offer at Google", {
          campaignId: campaign.id,
          error: String(err),
        });
      }
    }
    await markOfferExpired(campaign.id, now);
  }

  return { expired: due.length, pausedAtGoogle };
}

async function tick(): Promise<void> {
  try {
    const cycles = await runOfferCycleSweep();
    const renewals = await runRenewalSweep();
    const expiry = await runOfferExpirySweep();
    log("sweep complete", { cycles, renewals, expiry });
  } catch (err) {
    // Never throw out of the interval: an unhandled rejection here would take
    // the renderer down and stop encoding for every customer.
    log("sweep failed", String(err));
  }
}

export function startOfferScheduler(): void {
  void tick();
  const timer = setInterval(() => void tick(), INTERVAL_MS);
  // Do not hold the process open on its own account — the render loop decides
  // when this container lives and dies.
  timer.unref?.();
  log("offer scheduler started", { intervalMs: INTERVAL_MS });
}

import { and, desc, eq, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { campaigns, purchases, users } from "../../db/schema.js";
import { createPurchase } from "../cinematic/index.js";
import { chargeMinor, currencyForCountry, formatMinor, maybeAddOnFor, type AddOn } from "../pricing/index.js";
import { providerFor } from "../payments/index.js";
import { markSitevaultPaid } from "../sitevault/index.js";
import { billingIdentity } from "../testMode/index.js";

// The $10 website fee (2026-11-15). "Make me a website" creates the SiteVault
// site unpublished (awaitingPayment), then charges $10 (the first year of Pro
// included). The shared purchase webhook marks it paid; publishPaidWebsite then
// tells SiteVault (POST /api/internal/sites/<slug>/paid, idempotent on the
// purchase id) and only then sets the campaign's landing_url. Like the offer
// combo, a SiteVault failure never fails the payment: the sweep retries.

const WEB_ORIGIN = process.env.WEB_ORIGIN ?? "https://advault.3pandalabs.com";
export const WEBSITE_FEE_MAX_ATTEMPTS = 5;
const PAID = ["paid", "producing", "delivered"] as const;

/** The website add-on, priced for this user: the $0.50 test price for an admin testing as a customer. */
export type WebsiteFee = AddOn & { testMode: boolean };

/** The fee this advertiser pays for a website, or null (admins, at_cost, no price in their currency). */
export async function websiteFeeFor(userId: string): Promise<WebsiteFee | null> {
  const who = await billingIdentity(userId);
  if (!who.role || who.exempt) return null;
  const [u] = await db.select({ countryCode: users.countryCode }).from(users).where(eq(users.id, userId)).limit(1);
  const fee = maybeAddOnFor(currencyForCountry(u?.countryCode ?? "US"), "website");
  if (!fee) return null;
  const priceMinor = chargeMinor(fee.priceMinor, who.testMode);
  return { ...fee, priceMinor, firstPurchasePriceMinor: priceMinor, testMode: who.testMode };
}

export const feeDisplay = (fee: AddOn) => formatMinor(fee.priceMinor, fee.currency);

/** A Stripe checkout for the campaign's unpaid site. */
export async function startWebsiteCheckout(args: { userId: string; campaignId: string; slug: string; fee: WebsiteFee }) {
  const provider = providerFor(args.fee.currency);
  const purchase = await createPurchase({
    userId: args.userId,
    campaignId: args.campaignId,
    addOnKey: args.fee.key,
    amountMinor: args.fee.priceMinor,
    provider: provider.name,
  });
  await db.update(purchases).set({ websiteSlug: args.slug, updatedAt: new Date() }).where(eq(purchases.id, purchase.id));
  const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, args.userId)).limit(1);
  const session = await provider.createCheckout({
    paymentId: purchase.id,
    amountMinor: args.fee.priceMinor,
    currency: args.fee.currency,
    purpose: "add_on",
    testMode: args.fee.testMode,
    lineItems: [{ amountMinor: args.fee.priceMinor, name: "Your website (first year of Pro included)" }],
    userEmail: user?.email ?? "",
    returnUrl: `${WEB_ORIGIN}/dashboard/campaigns/${args.campaignId}?website=paid`,
  });
  await db.update(purchases).set({ providerRef: session.providerRef, updatedAt: new Date() }).where(eq(purchases.id, purchase.id));
  return { purchaseId: purchase.id, checkout: { provider: provider.name, redirectUrl: session.redirectUrl, clientPayload: session.clientPayload } };
}

/** The campaign's latest website-fee purchase. */
export async function latestWebsitePurchase(campaignId: string) {
  const [p] = await db
    .select()
    .from(purchases)
    .where(and(eq(purchases.campaignId, campaignId), eq(purchases.sku, "website")))
    .orderBy(desc(purchases.createdAt))
    .limit(1);
  return p ?? null;
}

export const isPaidStatus = (status: string) => (PAID as readonly string[]).includes(status);

/** Tell SiteVault a paid fee landed, then make the site the campaign's link. Never throws. */
export async function publishPaidWebsite(purchaseId: string): Promise<"published" | "skipped" | "failed"> {
  try {
    const [p] = await db.select().from(purchases).where(eq(purchases.id, purchaseId)).limit(1);
    if (!p || p.sku !== "website" || !p.websiteSlug || p.websitePublishedAt || !isPaidStatus(p.status)) return "skipped";
    const r = await markSitevaultPaid(p.websiteSlug, p.id);
    const now = new Date();
    if (!r.ok) {
      await db
        .update(purchases)
        .set({ websiteError: r.error.slice(0, 500), websiteAttempts: sql`${purchases.websiteAttempts} + 1`, updatedAt: now })
        .where(eq(purchases.id, p.id));
      console.warn(JSON.stringify({ msg: "website publish failed", purchaseId: p.id, error: r.error }));
      return "failed";
    }
    if (p.campaignId) {
      // Only fills an empty link: an owner who typed their own website since keeps it.
      await db
        .update(campaigns)
        .set({ landingUrl: r.siteUrl, sitevaultPendingUrl: null, updatedAt: now })
        .where(and(eq(campaigns.id, p.campaignId), isNull(campaigns.landingUrl)));
      await db.update(campaigns).set({ sitevaultPendingUrl: null }).where(eq(campaigns.id, p.campaignId));
    }
    await db
      .update(purchases)
      .set({
        websitePublishedAt: now,
        websiteError: null,
        websiteAttempts: sql`${purchases.websiteAttempts} + 1`,
        // Nothing to produce: /metrics counts 'paid' as awaiting production.
        status: "delivered",
        deliveredAt: now,
        updatedAt: now,
      })
      .where(eq(purchases.id, p.id));
    return "published";
  } catch (err) {
    console.error(JSON.stringify({ msg: "website publish threw", purchaseId, error: String(err) }));
    return "failed";
  }
}

/** Fire-and-forget after the payment is recorded: never awaited by the payment path. */
export function publishPaidWebsiteSoon(purchaseId: string): void {
  setImmediate(() => void publishPaidWebsite(purchaseId));
}

export async function runWebsiteSweep(): Promise<{ published: number; failed: number }> {
  const due = await db
    .select({ id: purchases.id })
    .from(purchases)
    .where(
      and(
        eq(purchases.sku, "website"),
        isNotNull(purchases.websiteSlug),
        isNull(purchases.websitePublishedAt),
        inArray(purchases.status, [...PAID]),
        lt(purchases.websiteAttempts, WEBSITE_FEE_MAX_ATTEMPTS),
        lt(purchases.updatedAt, sql`now() - interval '1 minute'`),
      ),
    )
    .orderBy(purchases.createdAt)
    .limit(20);
  let published = 0;
  let failed = 0;
  for (const { id } of due) {
    const r = await publishPaidWebsite(id);
    if (r === "published") published += 1;
    else if (r === "failed") failed += 1;
  }
  return { published, failed };
}

/** Every 10 minutes in the API (the only process holding SITEVAULT_INTERNAL_TOKEN). */
export function startWebsiteSweep(intervalMs = 10 * 60 * 1000): void {
  const tick = () =>
    runWebsiteSweep()
      .then((r) => {
        if (r.published || r.failed) console.log(JSON.stringify({ msg: "website fee sweep", ...r }));
      })
      .catch((err) => console.error(JSON.stringify({ msg: "website fee sweep threw", error: String(err) })));
  setInterval(tick, intervalMs).unref();
}

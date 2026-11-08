import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { adAccounts } from "../../db/schema.js";
import { mccAccessToken } from "../googleAds/mcc.js";
import {
  billingSetupUrl,
  getInvitationState,
  hasActiveBillingSetup,
  inviteCustomerUser,
  managerCustomerId,
} from "../googleAds/billingLink.js";
import type { BillingLinkStatus } from "./policy.js";

// Orchestration for the CUSTOMER-billed handshake on a freshly provisioned
// child account (platform billing lives in ./managedCard.ts). The pure decisions live in ./policy.ts; this is the part that talks
// to Google and writes rows.
//
// Every function here is written to RECORD failure rather than throw it at the
// advertiser. Provisioning already succeeded by the time any of this runs — the
// account exists, and losing the billing handshake to a transient 502 should
// leave a retryable row, not an orphaned customer.

type AccountRow = typeof adAccounts.$inferSelect;

/** Every function here runs after the child account exists at Google. */
function idOf(account: AccountRow): string {
  if (!idOf(account)) throw new Error("account_not_provisioned");
  return idOf(account);
}

async function setLinkState(
  accountId: string,
  patch: Partial<{
    billingLinkStatus: BillingLinkStatus;
    billingInvitationResourceName: string | null;
    billingInvitedAt: Date | null;
    billingConfirmedAt: Date | null;
    billingCheckedAt: Date | null;
    billingPaymentsAccountId: string | null;
    provisionError: string | null;
  }>,
): Promise<void> {
  await db.update(adAccounts).set(patch).where(eq(adAccounts.id, accountId));
}

export type CustomerLinkStart = {
  status: BillingLinkStatus;
  billingUrl: string;
  invitationSent: boolean;
  detail?: string;
};

/**
 * Invites the advertiser onto their own child account and hands back the URL
 * where they enter a card.
 *
 * Both halves are needed and neither is sufficient: without the invitation they
 * have no access to the account, and without the deep link they have access but
 * no idea where to go. The invitation is the part that can fail, so it is the
 * part whose failure is recorded.
 */
export async function startCustomerBillingLink(
  account: AccountRow,
  email: string,
): Promise<CustomerLinkStart> {
  const managerId = account.managerCustomerId ?? managerCustomerId();
  const billingUrl = billingSetupUrl(idOf(account));

  if (!managerId) {
    await setLinkState(account.id, { billingLinkStatus: "failed", provisionError: "no_manager_customer_id" });
    return { status: "failed", billingUrl, invitationSent: false, detail: "no_manager_customer_id" };
  }

  try {
    const accessToken = await mccAccessToken();
    const resourceName = await inviteCustomerUser({
      accessToken,
      customerId: idOf(account),
      email,
      loginCustomerId: managerId,
    });

    await setLinkState(account.id, {
      billingLinkStatus: "invited",
      billingInvitationResourceName: resourceName,
      billingInvitedAt: new Date(),
      billingCheckedAt: new Date(),
      provisionError: null,
    });

    return { status: "invited", billingUrl, invitationSent: true };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // 'pending' rather than 'failed': the account is fine and the invitation is
    // retryable, so the dashboard should offer "resend" rather than "contact
    // support". Only a structurally impossible state gets 'failed'.
    await setLinkState(account.id, {
      billingLinkStatus: "pending",
      billingCheckedAt: new Date(),
      provisionError: detail.slice(0, 500),
    });
    return { status: "pending", billingUrl, invitationSent: false, detail };
  }
}

export type BillingLinkSnapshot = {
  status: BillingLinkStatus;
  billingUrl: string;
  invitationState?: string;
  billingConfigured: boolean;
  detail?: string;
};

/**
 * Re-checks a mid-handshake account against Google.
 *
 * Billing setup is the authority, not invitation state. Google REMOVES an
 * invitation from customer_user_access_invitation once it is accepted, so a
 * missing invitation is ambiguous on its own — it means accepted, or never
 * sent. Asking "does this account have a funded billing setup" answers the
 * question we actually care about and sidesteps the ambiguity entirely.
 */
export async function refreshCustomerBillingLink(
  account: AccountRow,
  email: string,
): Promise<BillingLinkSnapshot> {
  const managerId = account.managerCustomerId ?? managerCustomerId();
  const billingUrl = billingSetupUrl(idOf(account));

  if (!managerId) {
    return { status: account.billingLinkStatus as BillingLinkStatus, billingUrl, billingConfigured: false };
  }

  try {
    const accessToken = await mccAccessToken();

    const configured = await hasActiveBillingSetup({
      accessToken,
      customerId: idOf(account),
      loginCustomerId: managerId,
    });

    if (configured) {
      await setLinkState(account.id, {
        billingLinkStatus: "active",
        billingConfirmedAt: account.billingConfirmedAt ?? new Date(),
        billingCheckedAt: new Date(),
        provisionError: null,
      });
      return { status: "active", billingUrl, billingConfigured: true };
    }

    const invitationState = await getInvitationState({
      accessToken,
      customerId: idOf(account),
      email,
      loginCustomerId: managerId,
    });

    // DECLINED and EXPIRED are terminal for this invitation but not for the
    // account — the caller can resend, which is why neither is 'failed'.
    const next: BillingLinkStatus =
      invitationState === "DECLINED" || invitationState === "EXPIRED" ? "pending" : "invited";

    await setLinkState(account.id, { billingLinkStatus: next, billingCheckedAt: new Date() });

    return { status: next, billingUrl, invitationState, billingConfigured: false };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // A failed poll must not downgrade a good state. Record that we looked and
    // leave the status alone.
    await setLinkState(account.id, { billingCheckedAt: new Date() });
    return {
      status: account.billingLinkStatus as BillingLinkStatus,
      billingUrl,
      billingConfigured: false,
      detail,
    };
  }
}

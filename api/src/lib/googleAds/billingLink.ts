import { googleAdsCall } from "./client.js";
import { googleAdsEnv } from "./env.js";

// Attaching a payment source to a child account — the half of onboarding the
// Google Ads API only partly exposes.
//
// ⚠️ THE CONSTRAINT THIS WHOLE FILE IS SHAPED AROUND: there is no API that adds
// a payment instrument. BillingSetupService can only point an account at a
// payments account that ALREADY EXISTS, and payments accounts are created by a
// human entering card details in Google's own UI. So:
//
//   billing_mode = 'platform'  — fully automatic. Our MCC already has a
//                                payments account; we create a BillingSetup on
//                                the child that points at it. Zero customer
//                                involvement.
//
//   billing_mode = 'customer'  — NOT automatable. We can invite the advertiser
//                                onto their own child account and deep-link
//                                them to the billing page, then poll until a
//                                billing setup appears. The card entry itself
//                                happens in Google's UI, by them, and nothing
//                                here can shortcut it.
//
// Everything below is written against the documented v18 contracts but has NOT
// been exercised against a live developer token — AdVault does not have Standard
// access yet (see infra/google-ads-setup.md). Treat the response shapes as
// best-effort until someone runs them for real; the call sites all degrade to a
// recorded 'failed' status rather than throwing into a user's face.

/** Reads are cheap and idempotent; mutates are not. Kept separate deliberately. */

export type PaymentsAccount = {
  resourceName: string;
  paymentsAccountId: string;
  name?: string;
  currencyCode?: string;
};

/**
 * Payments accounts visible to `customerId` — in practice the MCC, which is the
 * only account in this system that has one.
 *
 * A manager with no payments account returns an empty list rather than an
 * error, which is the case worth handling: it means nobody has ever entered a
 * card for the MCC, and platform billing cannot work until someone does.
 */
export async function listPaymentsAccounts(args: {
  accessToken: string;
  customerId: string;
  loginCustomerId?: string;
}): Promise<PaymentsAccount[]> {
  const body = await googleAdsCall<{
    paymentsAccounts?: {
      resourceName?: string;
      paymentsAccountId?: string;
      name?: string;
      currencyCode?: string;
    }[];
  }>(`/customers/${args.customerId}/paymentsAccounts:list`, args.accessToken, {
    method: "GET",
    loginCustomerId: args.loginCustomerId,
  });

  return (body.paymentsAccounts ?? [])
    .filter((p) => p.resourceName && p.paymentsAccountId)
    .map((p) => ({
      resourceName: p.resourceName!,
      paymentsAccountId: p.paymentsAccountId!,
      name: p.name,
      currencyCode: p.currencyCode,
    }));
}

export type BillingSetupStatus = "PENDING" | "APPROVED" | "APPROVED_HELD" | "CANCELLED" | "UNKNOWN";

export type BillingSetupSummary = {
  resourceName: string;
  status: BillingSetupStatus;
  paymentsAccount?: string;
};

/**
 * Billing setups on an account, newest first.
 *
 * This is the poll that tells us whether a customer-funded advertiser has
 * actually entered a card. An account with no rows here cannot spend, so
 * launching into it would create a campaign that silently never serves.
 *
 * CANCELLED setups are returned too — a customer who added and then removed a
 * card looks different from one who never added one, and the dashboard should
 * be able to say so.
 */
export async function listBillingSetups(args: {
  accessToken: string;
  customerId: string;
  loginCustomerId?: string;
}): Promise<BillingSetupSummary[]> {
  const body = await googleAdsCall<{
    results?: {
      billingSetup?: { resourceName?: string; status?: string; paymentsAccount?: string };
    }[];
  }>(`/customers/${args.customerId}/googleAds:search`, args.accessToken, {
    method: "POST",
    loginCustomerId: args.loginCustomerId,
    body: {
      query:
        "SELECT billing_setup.resource_name, billing_setup.status, billing_setup.payments_account " +
        "FROM billing_setup",
    },
  });

  return (body.results ?? [])
    .filter((r) => r.billingSetup?.resourceName)
    .map((r) => ({
      resourceName: r.billingSetup!.resourceName!,
      status: (r.billingSetup!.status as BillingSetupStatus) ?? "UNKNOWN",
      paymentsAccount: r.billingSetup!.paymentsAccount,
    }));
}

/** APPROVED_HELD still spends — Google holds payment, not delivery. */
export function isFundedStatus(status: BillingSetupStatus): boolean {
  return status === "APPROVED" || status === "APPROVED_HELD";
}

export async function hasActiveBillingSetup(args: {
  accessToken: string;
  customerId: string;
  loginCustomerId?: string;
}): Promise<boolean> {
  const setups = await listBillingSetups(args);
  return setups.some((s) => isFundedStatus(s.status));
}

/**
 * Points a child account at an existing payments account — the 'platform'
 * billing path, and the only fully automatic one.
 *
 * Note the singular `operation`: MutateBillingSetup takes one, unlike the
 * `operations` array every other mutate in this codebase uses. Sending an array
 * here fails with a shape error that reads like an auth problem.
 */
export async function attachPlatformBilling(args: {
  accessToken: string;
  childCustomerId: string;
  paymentsAccountResourceName: string;
  loginCustomerId: string;
}): Promise<string> {
  const body = await googleAdsCall<{ result?: { resourceName?: string } }>(
    `/customers/${args.childCustomerId}/billingSetups:mutate`,
    args.accessToken,
    {
      method: "POST",
      loginCustomerId: args.loginCustomerId,
      body: {
        operation: {
          create: {
            paymentsAccount: args.paymentsAccountResourceName,
          },
        },
      },
    },
  );

  const resourceName = body.result?.resourceName;
  if (!resourceName) throw new Error("Google Ads returned no resource name for the billing setup");
  return resourceName;
}

export type AccessRole = "ADMIN" | "STANDARD" | "READ_ONLY" | "EMAIL_ONLY";

/**
 * Invites an advertiser onto their own child account.
 *
 * ADMIN is not a convenience here — it is the minimum role Google requires to
 * add a payment method. STANDARD can run campaigns but cannot set up billing,
 * which would strand the customer one step from the finish line with no way to
 * tell them why.
 *
 * Also singular `operation`.
 */
export async function inviteCustomerUser(args: {
  accessToken: string;
  customerId: string;
  email: string;
  loginCustomerId: string;
  accessRole?: AccessRole;
}): Promise<string> {
  const body = await googleAdsCall<{ result?: { resourceName?: string } }>(
    `/customers/${args.customerId}/customerUserAccessInvitations:mutate`,
    args.accessToken,
    {
      method: "POST",
      loginCustomerId: args.loginCustomerId,
      body: {
        operation: {
          create: {
            emailAddress: args.email,
            accessRole: args.accessRole ?? "ADMIN",
          },
        },
      },
    },
  );

  const resourceName = body.result?.resourceName;
  if (!resourceName) throw new Error("Google Ads returned no resource name for the invitation");
  return resourceName;
}

export type InvitationState = "PENDING" | "DECLINED" | "EXPIRED" | "GONE";

/**
 * State of the outstanding invitation for `email`.
 *
 * "GONE" is the interesting one and is NOT an error: Google removes an
 * invitation from this resource once it is accepted, so a missing row means
 * either accepted or never sent. The caller disambiguates by checking whether a
 * billing setup now exists — which is the thing we actually care about anyway.
 */
export async function getInvitationState(args: {
  accessToken: string;
  customerId: string;
  email: string;
  loginCustomerId: string;
}): Promise<InvitationState> {
  const body = await googleAdsCall<{
    results?: {
      customerUserAccessInvitation?: { invitationStatus?: string; emailAddress?: string };
    }[];
  }>(`/customers/${args.customerId}/googleAds:search`, args.accessToken, {
    method: "POST",
    loginCustomerId: args.loginCustomerId,
    body: {
      query:
        "SELECT customer_user_access_invitation.invitation_status, " +
        "customer_user_access_invitation.email_address " +
        "FROM customer_user_access_invitation",
    },
  });

  const target = args.email.trim().toLowerCase();
  const match = (body.results ?? []).find(
    (r) => r.customerUserAccessInvitation?.emailAddress?.trim().toLowerCase() === target,
  );

  if (!match) return "GONE";
  const status = match.customerUserAccessInvitation?.invitationStatus;
  if (status === "DECLINED") return "DECLINED";
  if (status === "EXPIRED") return "EXPIRED";
  return "PENDING";
}

/**
 * Where to send a customer to enter their card.
 *
 * Best-effort: `__c` selects the account, but Google's billing console is not a
 * documented deep-link surface and an expired session drops the parameter and
 * lands them on the account picker instead. That is survivable — the flow tells
 * them which account to pick — but it is why onboarding is a guided call for the
 * first cohort rather than a self-serve link.
 */
export function billingSetupUrl(customerId: string): string {
  return `https://ads.google.com/aw/billing/setup?__c=${encodeURIComponent(customerId)}`;
}

/** The MCC id every call above needs as login-customer-id, dashes stripped. */
export function managerCustomerId(): string | null {
  const raw = googleAdsEnv.loginCustomerId;
  return raw ? raw.replace(/-/g, "") : null;
}

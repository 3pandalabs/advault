import { eq } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { db } from "../../db/index.js";
import { users } from "../../db/schema.js";
import type { UserRole } from "../../auth/jwt.js";
import { billingExempt, effectiveMarginMode, effectiveRole, inTestMode, isTestCustomer } from "./policy.js";

// Admin "Test as customer": the database side. Read ./policy.ts first.

export type BillingIdentity = {
  /** The role customer flows act on (admin in test mode = advertiser). */
  role: UserRole | undefined;
  marginMode: "standard" | "at_cost";
  /** Admin testing as a customer: charge TEST_PRICE_MINOR. */
  testMode: boolean;
  /** Skips per-ad fees, website fees and plan gates. */
  exempt: boolean;
  /** An admin's test customer (0030): launch is always a dry run. */
  testCustomer: boolean;
  /**
   * 3PandaLabs' own account (0032). Changes NO pricing or gate: only names
   * ("INTERNAL · "), Stripe metadata (`internal=1`) and revenue reporting.
   */
  internal: boolean;
  internalLabel: string | null;
};

/** How billing and perk gates should treat this user right now. */
export async function billingIdentity(userId: string): Promise<BillingIdentity> {
  const [u] = await db
    .select({
      role: users.role,
      marginMode: users.marginMode,
      testAsCustomer: users.testAsCustomer,
      testOwnerId: users.testOwnerId,
      isInternal: users.isInternal,
      internalLabel: users.internalLabel,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!u) {
    return { role: undefined, marginMode: "standard", testMode: false, exempt: false, testCustomer: false, internal: false, internalLabel: null };
  }
  return {
    testCustomer: isTestCustomer(u),
    internal: u.isInternal,
    internalLabel: u.isInternal ? u.internalLabel : null,
    role: effectiveRole(u),
    marginMode: effectiveMarginMode(u),
    testMode: inTestMode(u),
    exempt: billingExempt(u),
  };
}

/** Is this user an admin testing as a customer, or a test customer? */
export async function isTestMode(userId: string): Promise<boolean> {
  return (await billingIdentity(userId)).testMode;
}

/**
 * The JWT role, corrected for test mode, for customer flows that gate on
 * `req.userRole`. Only admins cost a lookup (the JWT cannot carry the flag:
 * it would go stale for 15 minutes after a toggle).
 */
export async function customerFlowRole(req: FastifyRequest): Promise<UserRole | undefined> {
  if (req.userRole !== "admin" || !req.userId) return req.userRole;
  return (await billingIdentity(req.userId)).role;
}

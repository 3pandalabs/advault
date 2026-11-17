import type { Me } from "@/lib/api/browser";

// Admin "Test as customer" (api/src/lib/testMode). While an admin has it on,
// the API bills them exactly like a standard advertiser and every charge is
// 50 cents. Prices normally come from the API already; this is for the few
// strings that name a price in copy.

/** What every charge costs in test mode (api: lib/pricing TEST_PRICE_MINOR). */
export const TEST_PRICE_DISPLAY = "$0.50";

/** Should a customer screen treat this user as an admin? Not while testing as a customer. */
export function actsAsAdmin(me: Pick<Me, "role" | "testAsCustomer"> | null | undefined): boolean {
  return me?.role === "admin" && !me.testAsCustomer;
}

/** A price written in copy ("$10"), or the test price while testing as a customer. */
export function shownPrice(normal: string, testMode: boolean | undefined): string {
  return testMode ? TEST_PRICE_DISPLAY : normal;
}

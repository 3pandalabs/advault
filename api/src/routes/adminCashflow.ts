import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import { requireAdminOrAnalyticsToken } from "../auth/adminAccess.js";

// The org admin site's "Cash flow by product" table (3pandalabs/admin,
// src/finance.js /api/finance/products): which part of the money AdVault took
// through Stripe is ad budget (pass-through to Google, never revenue) and
// which part is AdVault's own fees. The wallet ledger already draws that line:
//   topup  credits: every payment a wallet received (budget top-ups, the
//                   paired credit of an externally paid fee, a plan's monthly
//                   ad budget)
//   fee    debits:  AdVault's fees, whether paid by card or from the budget
//   refund debits:  budget handed back
// so per month, budget money still in wallets = topups - fees - refunds
// (`budgetInMinor`). An externally paid fee nets to zero there, and a fee
// taken from the budget moves that money from budget to revenue.
//
// Aggregates per UTC month and currency only: no user ids, emails or names.
// Every account is counted (test and internal ones included) because the admin
// page sets this against the Stripe money, which includes their charges too.
// `until` is exclusive.

export type LedgerMonthRow = { month: string; currency: string; type: string; total: number | string };

export type LedgerMonth = {
  month: string;
  currency: string;
  topupMinor: number;
  feeMinor: number;
  refundMinor: number;
  spendMinor: number;
  adjustmentMinor: number;
  budgetInMinor: number;
};

/** Signed ledger sums per (month, currency, type) -> one positive-amounts row per month and currency. */
export function ledgerMonths(rows: LedgerMonthRow[]): LedgerMonth[] {
  const out = new Map<string, LedgerMonth>();
  for (const r of rows) {
    const key = `${r.month}|${r.currency}`;
    const m =
      out.get(key) ??
      { month: r.month, currency: r.currency, topupMinor: 0, feeMinor: 0, refundMinor: 0, spendMinor: 0, adjustmentMinor: 0, budgetInMinor: 0 };
    const total = Number(r.total);
    if (r.type === "topup") m.topupMinor += total;
    else if (r.type === "fee") m.feeMinor += -total;
    else if (r.type === "refund") m.refundMinor += -total;
    else if (r.type === "spend") m.spendMinor += -total;
    else if (r.type === "adjustment") m.adjustmentMinor += total;
    out.set(key, m);
  }
  const list = [...out.values()].map((m) => ({ ...m, budgetInMinor: m.topupMinor - m.feeMinor - m.refundMinor }));
  return list.sort((a, b) => a.month.localeCompare(b.month) || a.currency.localeCompare(b.currency));
}

export async function adminCashflowRoutes(app: FastifyInstance) {
  app.get(
    "/admin/cashflow",
    {
      preHandler: requireAdminOrAnalyticsToken,
      schema: {
        querystring: z.object({
          since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        }),
      },
    },
    async (req) => {
      const { since, until } = req.query as { since: string; until: string };
      const rows = (
        await db.execute<LedgerMonthRow>(sql`
          select to_char(date_trunc('month', le.created_at at time zone 'UTC'), 'YYYY-MM') as month,
            le.currency_code as currency, le.type, sum(le.amount_minor)::bigint as total
          from ledger_entries le
          where le.created_at >= ${`${since}T00:00:00Z`}::timestamptz
            and le.created_at < ${`${until}T00:00:00Z`}::timestamptz
          group by 1, 2, 3
        `)
      ).rows;
      return { since, until, months: ledgerMonths(rows) };
    },
  );
}

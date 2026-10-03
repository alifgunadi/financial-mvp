import { Router } from "express";
import { db } from "../../infra/db.js";
import { prismaCause, sendError } from "../../infra/logger.js";
import { requireAuth } from "../../shared/auth.js";
import { badRequest, unauthorized } from "../../shared/http.js";
import { summarySchema } from "../../validate.js";
import { toApiTransaction } from "../transactions/mappers.js";

const dashboardRoutes = Router();

// Spending pace helpers (dashboard only). Calendar-safe by construction:
// pure UTC calendar dates, never division of local timestamps.
function parseCalendarDate(s: string): number {
  const [y, m, d] = s.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

// Daily spending guide from existing Transaction aggregates only.
// Null when not computable (unbounded or ended period). Status describes
// the period balance, never just today's overspend.
function toSpendingPace(opts: {
  asOf: string;
  to: string | null;
  totalIncome: number;
  totalExpense: number;
  spentToday: number;
}):
  | {
    asOf: string;
    remainingDays: number;
    recommendedMaxPerDay: number;
    spentToday: number;
    remainingToday: number;
    status: string;
  }
  | null {
  const { asOf, to, totalIncome, totalExpense, spentToday } = opts;
  if (to === null) return null; // unbounded: no end date to pace against
  const remainingDays =
    Math.round((parseCalendarDate(to) - parseCalendarDate(asOf)) / 86_400_000) + 1;
  if (remainingDays <= 0) return null; // period ended: never divide by zero
  const balance = totalIncome - totalExpense;
  if (balance < 0)
    return {
      asOf,
      remainingDays,
      recommendedMaxPerDay: 0,
      spentToday,
      remainingToday: 0 - spentToday,
      status: "over_budget",
    };
  // Floor: daily maxima over the remaining days can never exceed balance.
  const recommendedMaxPerDay = Math.floor(balance / remainingDays);
  const status = totalIncome === 0 && totalExpense === 0 ? "no_data" : "on_track";
  return {
    asOf,
    remainingDays,
    recommendedMaxPerDay,
    spentToday,
    remainingToday: recommendedMaxPerDay - spentToday,
    status,
  };
}

dashboardRoutes.get("/summary", requireAuth, async (req, res) => {
  const parsed = summarySchema.safeParse(req.query);
  if (!parsed.success) return badRequest(res, req, parsed.error, "dashboard_summary");
  if (!req.user) return unauthorized(res, req);
  const userId = req.user.id;
  const { from, to } = parsed.data;
  const dateRange =
    from || to
      ? {
        date: {
          ...(from ? { gte: new Date(`${from}T00:00:00Z`) } : {}),
          ...(to ? { lte: new Date(`${to}T00:00:00Z`) } : {}),
        },
      }
      : {};
  try {
    // All math in SQL (SUM / GROUP BY), scoped to the caller. Only aggregates cross the wire.
    // spentToday is deliberately outside the period filter: it is always
    // "today", while the period itself is user-selected (may be past/future).
    const asOf = new Date().toISOString().slice(0, 10);
    const todayStart = new Date(`${asOf}T00:00:00Z`);
    const [income, expense, groups, recent, spent] = await Promise.all([
      db.transaction.aggregate({
        _sum: { amount: true },
        where: { ...dateRange, userId, type: "INCOME" },
      }),
      db.transaction.aggregate({
        _sum: { amount: true },
        where: { ...dateRange, userId, type: "EXPENSE" },
      }),
      db.transaction.groupBy({
        by: ["categoryId"],
        _sum: { amount: true },
        where: { ...dateRange, userId, type: "EXPENSE" },
      }),
      db.transaction.findMany({
        where: { ...dateRange, userId },
        include: { category: true },
        orderBy: [{ date: "desc" }, { createdAt: "desc" }],
        take: 5,
      }),
      db.transaction.aggregate({
        _sum: { amount: true },
        where: {
          userId,
          type: "EXPENSE",
          date: { gte: todayStart, lte: todayStart },
        },
      }),
    ]);
    // Uncategorized import rows group under a null categoryId, which
    // needs no lookup and is labeled below. Totals are unaffected: the
    // SUM aggregates above have no category filter.
    const categorizedIds = groups
      .map((g) => g.categoryId)
      .filter((id): id is string => id !== null);
    const categories = categorizedIds.length
      ? await db.category.findMany({
        where: { userId, id: { in: categorizedIds } },
      })
      : [];
    const nameOf = new Map(categories.map((c) => [c.id, c.name]));
    const totalIncome = Number(income._sum.amount ?? 0);
    const totalExpense = Number(expense._sum.amount ?? 0);
    res.json({
      from: from ?? null,
      to: to ?? null,
      totalIncome,
      totalExpense,
      // Period net flow (income − expense), NOT an account balance.
      balance: totalIncome - totalExpense, expenseByCategory: groups
        .map((g) => ({
          categoryId: g.categoryId,
          name:
            g.categoryId === null
              ? "Uncategorized"
              : (nameOf.get(g.categoryId) ?? "Unknown"),
          total: Number(g._sum.amount ?? 0),
        }))
        .sort((a, b) => b.total - a.total),
      recent: recent.map(toApiTransaction),
      // Additive daily guide (null when unbounded/ended). Existing fields above unchanged.
      spendingPace: toSpendingPace({
        asOf,
        to: to ?? null,
        totalIncome,
        totalExpense,
        spentToday: Number(spent._sum.amount ?? 0),
      }),
    });
  } catch (e) {
    sendError(res, req, {
      status: 500,
      code: "DATABASE_ERROR",
      message: "failed to load dashboard summary",
      operation: "dashboard_summary",
      causeCode: prismaCause(e),
      err: e,
    });
  }
});

export { dashboardRoutes };

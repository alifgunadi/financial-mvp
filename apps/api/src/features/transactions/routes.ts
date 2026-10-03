import { Router } from "express";
import { Prisma } from "@prisma/client";
import { db } from "../../infra/db.js";
import { prismaCause, sendError } from "../../infra/logger.js";
import { requireAuth } from "../../shared/auth.js";
import { categoryMatchesType, toDb } from "../../shared/enums.js";
import { badRequest, unauthorized } from "../../shared/http.js";
import { toApiTransaction } from "./mappers.js";
import { createTransactionSchema, listTransactionsSchema } from "./schemas.js";

const transactionsRoutes = Router();

transactionsRoutes.get("/", requireAuth, async (req, res) => {
  const parsed = listTransactionsSchema.safeParse(req.query);
  if (!parsed.success) return badRequest(res, req, parsed.error, "list_transactions");
  if (!req.user) return unauthorized(res, req);
  const { type, categoryId, from, to, limit, offset } = parsed.data;
  const where: Prisma.TransactionWhereInput = {
    userId: req.user.id,
    ...(type ? { type: toDb(type) } : {}),
    ...(categoryId ? { categoryId } : {}),
    ...(from || to
      ? {
        date: {
          ...(from ? { gte: new Date(`${from}T00:00:00Z`) } : {}),
          ...(to ? { lte: new Date(`${to}T00:00:00Z`) } : {}),
        },
      }
      : {}),
  };
  try {
    const [total, rows] = await Promise.all([
      db.transaction.count({ where }),
      db.transaction.findMany({
        where,
        include: { category: true },
        orderBy: [{ date: "desc" }, { createdAt: "desc" }],
        take: limit,
        skip: offset,
      }),
    ]);
    res.json({
      data: rows.map(toApiTransaction),
      total,
    });
  } catch (e) {
    sendError(res, req, {
      status: 500,
      code: "DATABASE_ERROR",
      message: "failed to list transactions",
      operation: "list_transactions",
      causeCode: prismaCause(e),
      err: e,
    });
  }
});

transactionsRoutes.post("/", requireAuth, async (req, res) => {
  const parsed = createTransactionSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, req, parsed.error, "create_transaction");
  if (!req.user) return unauthorized(res, req);
  const userId = req.user.id;
  const { type, amount, date, categoryId, note, merchant } = parsed.data;
  // Ownership check: the category must belong to the caller.
  // Same "not found" message as a missing id: no existence leak.
  const category = await db.category
    .findFirst({
      where: { id: categoryId, userId },
      select: { id: true, type: true },
    })
    .catch(() => null);
  if (!category)
    return sendError(res, req, {
      status: 400,
      code: "VALIDATION_ERROR",
      message: "category not found",
      operation: "create_transaction",
    });
  // Type compatibility: BOTH fits everywhere, otherwise the category
  // type must equal the transaction type. Client filtering is UX only;
  // this is the final validation.
  if (!categoryMatchesType(category.type, toDb(type)))
    return sendError(res, req, {
      status: 400,
      code: "VALIDATION_ERROR",
      message: "category type mismatch",
      operation: "create_transaction",
    });
  try {
    const t = await db.transaction.create({
      data: {
        type: toDb(type),
        amount: BigInt(amount),
        date: new Date(`${date}T00:00:00Z`),
        note: note || null,
        merchant: merchant || null,
        source: "MANUAL",
        userId,
        categoryId,
      },
      include: { category: true },
    });
    res.status(201).json(toApiTransaction(t));
  } catch (e) {
    sendError(res, req, {
      status: 500,
      code: "DATABASE_ERROR",
      message: "failed to create transaction",
      operation: "create_transaction",
      causeCode: prismaCause(e),
      err: e,
    });
  }
});

export { transactionsRoutes };

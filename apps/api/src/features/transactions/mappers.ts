import { Prisma } from "@prisma/client";
import { toApi } from "../../shared/enums.js";
import { toDateString } from "../../shared/dates.js";

// Prisma Transaction with included category → API shape.
// BigInt stays integer end-to-end (Number() of a BigInt, never float math).
type TxWithCategory = Prisma.TransactionGetPayload<{
  include: { category: true };
}>;

function toApiTransaction(t: TxWithCategory) {
  return {
    id: t.id,
    type: toApi(t.type),
    amount: Number(t.amount),
    date: toDateString(t.date),
    note: t.note,
    merchant: t.merchant,
    // Null for statement-import rows confirmed without a category.
    // Manual creation still requires one, so those rows always have it.
    category: t.category
      ? {
        id: t.category.id,
        name: t.category.name,
        type: toApi(t.category.type),
      }
      : null,
    createdAt: t.createdAt.toISOString(),
  };
}

export { toApiTransaction };
export type { TxWithCategory };

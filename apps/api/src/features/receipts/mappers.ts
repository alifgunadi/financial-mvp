import { Prisma } from "@prisma/client";
import { toApi } from "../../shared/enums.js";
import { toDateString } from "../../shared/dates.js";

// Prisma Receipt with the reviewer's chosen category → Stage 4 shape.
// Never exposes filePath, userId, sessions, or provider internals.
type ReceiptWithSuggestion = Prisma.ReceiptGetPayload<{
  include: { suggestedCategory: true };
}>;

// rawAiJson holds only the successful extraction candidate (written by
// the extract handler). Anything else shaped → null, never an error.
function toAiOriginal(raw: unknown) {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const amount =
    typeof o.amount === "number" &&
      Number.isInteger(o.amount) &&
      (o.amount as number) > 0
      ? (o.amount as number)
      : null;
  const date = typeof o.date === "string" ? (o.date as string) : null;
  const merchant = typeof o.merchant === "string" ? (o.merchant as string) : null;
  const type =
    o.type === "EXPENSE" || o.type === "INCOME" ? toApi(o.type as string) : null;
  const category = typeof o.category === "string" ? (o.category as string) : null;
  return { amount, date, merchant, type, category };
}

function toApiReceipt(r: ReceiptWithSuggestion) {
  return {
    id: r.id,
    status: toApi(r.status),
    extraction: {
      amount: r.extractedAmount === null ? null : Number(r.extractedAmount),
      date: r.extractedDate ? toDateString(r.extractedDate) : null,
      merchant: r.extractedMerchant,
      type: r.extractedType ? toApi(r.extractedType) : null,
      category: r.extractedCategory,
    },
    suggestedCategory: r.suggestedCategory
      ? {
        id: r.suggestedCategory.id,
        name: r.suggestedCategory.name,
        type: toApi(r.suggestedCategory.type),
      }
      : null,
    aiOriginal: toAiOriginal(r.rawAiJson),
    extractedAt: r.extractedAt ? r.extractedAt.toISOString() : null,
    error: r.error,
  };
}

export { toApiReceipt };
export type { ReceiptWithSuggestion };

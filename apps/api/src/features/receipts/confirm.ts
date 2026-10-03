import { db } from "../../infra/db.js";
import { ConfirmConflictError, ConfirmValidationError } from "../../shared/errors.js";
import { categoryMatchesType } from "../../shared/enums.js";
import type { TxWithCategory } from "../transactions/mappers.js";
import type { ReceiptWithSuggestion } from "./mappers.js";

type StoredReviewValues = {
  extractedAmount: bigint | null;
  extractedType: "INCOME" | "EXPENSE" | null;
  extractedDate: Date | null;
  extractedMerchant: string | null;
  suggestedCategoryId: string | null;
};

type ReadyReviewValues = {
  amount: bigint;
  type: "INCOME" | "EXPENSE";
  date: Date;
  merchant: string | null;
  categoryId: string;
};

async function validateStoredReviewForConfirm(
  review: StoredReviewValues,
  userId: string,
): Promise<ReadyReviewValues> {
  if (
    review.extractedAmount === null ||
    review.extractedType === null ||
    review.extractedDate === null ||
    review.suggestedCategoryId === null
  )
    throw new ConfirmValidationError("receipt review incomplete");
  // Ownership + type compatibility, same rules as manual creation.
  const category = await db.category
    .findFirst({
      where: { id: review.suggestedCategoryId, userId },
      select: { id: true, type: true },
    })
    .catch(() => null);
  if (!category) throw new ConfirmValidationError("category not found");
  if (!categoryMatchesType(category.type, review.extractedType))
    throw new ConfirmValidationError("category type mismatch");
  return {
    amount: review.extractedAmount,
    type: review.extractedType,
    date: review.extractedDate,
    merchant: review.extractedMerchant,
    categoryId: review.suggestedCategoryId,
  };
}

async function claimAndCreateReceiptTransaction(
  receiptId: string,
  userId: string,
  vals: ReadyReviewValues,
): Promise<{ created: TxWithCategory; updated: ReceiptWithSuggestion }> {
  return db.$transaction(async (tx) => {
    // Atomic claim: the conditional update holds the row lock, so a
    // concurrent confirm blocks here, then finds no confirmable row
    // after the first commits and gets a 409. Crash before commit
    // rolls the claim back, leaving the receipt confirmable for retry.
    const claimed = await tx.receipt.updateMany({
      where: { id: receiptId, userId, status: "NEEDS_REVIEW" },
      data: { status: "PROCESSING" },
    });
    if (claimed.count === 0) throw new ConfirmConflictError();
    // Full-review write from the validated POST /confirm payload: review
    // fields, Transaction, and CONFIRMED status share this transaction,
    // so any failure rolls everything back to NEEDS_REVIEW.
    // No note field exists on receipts.
    await tx.receipt.update({
      where: { id: receiptId },
      data: {
        extractedAmount: vals.amount,
        extractedDate: vals.date,
        extractedMerchant: vals.merchant,
        extractedType: vals.type,
        suggestedCategoryId: vals.categoryId,
      },
    });
    const created = await tx.transaction.create({
      data: {
        type: vals.type,
        amount: vals.amount,
        date: vals.date,
        note: null,
        merchant: vals.merchant,
        source: "RECEIPT" as const,
        userId,
        categoryId: vals.categoryId,
        receiptId,
      },
      include: { category: true },
    });
    const updated = await tx.receipt.update({
      where: { id: receiptId },
      data: { status: "CONFIRMED" },
      include: { suggestedCategory: true },
    });
    return { created, updated };
  });
}

export { claimAndCreateReceiptTransaction, validateStoredReviewForConfirm };

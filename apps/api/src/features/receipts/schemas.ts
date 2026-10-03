import { z } from "zod";
import { dateSchema, transactionTypeSchema } from "../../validate.js";

// Shared review field rules: PUT (partial edit) and POST /confirm (full
// review carried in the body) validate the same shapes, so neither can
// drift from the other.
const reviewAmountSchema = z
  .number()
  .int("amount must be an integer")
  .positive("amount must be greater than 0")
  .max(Number.MAX_SAFE_INTEGER);
const reviewMerchantSchema = z.string().trim().max(200);
const reviewCategoryIdSchema = z.string().uuid("categoryId must be a uuid");

// Stage 4 review: partial edit of the AI candidate on a NEEDS_REVIEW
// receipt. Every field optional+nullable (null clears it); at least one
// key must be present. Same money/date rules as transaction creation.
export const updateReceiptSchema = z
  .object({
    amount: reviewAmountSchema.nullable().optional(),
    date: dateSchema.nullable().optional(),
    merchant: reviewMerchantSchema.nullable().optional(),
    type: transactionTypeSchema.nullable().optional(),
    categoryId: reviewCategoryIdSchema.nullable().optional(),
  })
  .refine((o) => Object.keys(o).length > 0, "at least one review field is required");

// POST /confirm carries the full review in the body: amount/date/type/
// category are required non-null; merchant stays optional (absent keeps
// the stored review value, explicit null clears it — same rule as PUT).
export const confirmReceiptSchema = z.object({
  amount: reviewAmountSchema,
  date: dateSchema,
  merchant: reviewMerchantSchema.nullable().optional(),
  type: transactionTypeSchema,
  categoryId: reviewCategoryIdSchema,
});

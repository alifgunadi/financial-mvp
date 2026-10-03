import { z } from "zod";

// API uses lowercase types; mapped to Prisma enums in routes.
// categoryTypeSchema lives with its only consumer (features/categories).
export const transactionTypeSchema = z.enum(["income", "expense"]);

// YYYY-MM-DD calendar date (stored explicitly, no time component).
export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD")
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, "invalid calendar date");

// listCategoriesSchema + createCategorySchema live in
// features/categories/schemas.ts; createTransactionSchema +
// listTransactionsSchema live in features/transactions/schemas.ts.
// summarySchema stays here: the dashboard target has no schemas.ts and
// it is only consumed via the dashboard route below.
export const summarySchema = z.object({
  from: dateSchema.optional(),
  to: dateSchema.optional(),
});

// updateReceiptSchema + confirmReceiptSchema (and their shared review
// field rules) live in features/receipts/schemas.ts.

// Statement import upload: explicit bank identifier only (never guessed).
// Absent = unresolved, filled by a future detection phase. Multipart text
// fields arrive as strings; anything else (e.g. repeated fields) is rejected.
export const createImportSchema = z.object({
  bank: z
    .string()
    .trim()
    .min(1, "bank must not be empty")
    .max(50, "bank is too long")
    .regex(/^[A-Za-z0-9 _-]+$/, "bank has invalid characters")
    .optional(),
});

// Statement import confirm: category assignment per READY candidate.
// Keyed by deterministic fingerprint (rowIndex is per-pocket, not unique).
// categoryId is optional here (null = uncategorized import row); manual
// transaction creation still requires one (createTransactionSchema).
// Exact-set matching against the parser output is enforced in the handler.
export const confirmImportSchema = z.object({
  candidates: z.array(
    z.object({
      fingerprint: z
        .string()
        .regex(/^[0-9a-f]{64}$/, "fingerprint must be sha256 hex"),
      categoryId: z.string().uuid("categoryId must be a uuid").nullable(),
    }),
  ),
});

// authSchema lives in features/auth/schemas.ts. CreateCategoryInput and
// CreateTransactionInput moved with their schemas (same filenames).

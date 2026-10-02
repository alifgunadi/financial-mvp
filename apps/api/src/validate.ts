import { z } from "zod";

// API uses lowercase types; mapped to Prisma enums in index.ts.
export const categoryTypeSchema = z.enum(["income", "expense", "both"]);
export const transactionTypeSchema = z.enum(["income", "expense"]);

// YYYY-MM-DD calendar date (stored explicitly, no time component).
export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD")
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, "invalid calendar date");

export const listCategoriesSchema = z.object({
  type: categoryTypeSchema.optional(),
});

export const createCategorySchema = z.object({
  name: z.string().trim().min(1, "name is required").max(100),
  type: categoryTypeSchema,
});

// Amount = whole IDR units (50000 = Rp50.000), strictly positive. No floats.
export const createTransactionSchema = z.object({
  type: transactionTypeSchema,
  amount: z
    .number()
    .int("amount must be an integer")
    .positive("amount must be greater than 0")
    .max(Number.MAX_SAFE_INTEGER),
  date: dateSchema,
  categoryId: z.string().uuid("categoryId must be a uuid"),
  note: z.string().trim().max(500).optional(),
  // Optional merchant label; receipt extraction will populate this later.
  merchant: z.string().trim().max(200).optional(),
});

export const listTransactionsSchema = z.object({  type: transactionTypeSchema.optional(),
  categoryId: z.string().uuid().optional(),
  from: dateSchema.optional(),
  to: dateSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const summarySchema = z.object({
  from: dateSchema.optional(),
  to: dateSchema.optional(),
});

// Stage 4 review: partial edit of the AI candidate on a NEEDS_REVIEW
// receipt. Every field optional+nullable (null clears it); at least one
// key must be present. Same money/date rules as transaction creation.
export const updateReceiptSchema = z
  .object({
    amount: z
      .number()
      .int("amount must be an integer")
      .positive("amount must be greater than 0")
      .max(Number.MAX_SAFE_INTEGER)
      .nullable()
      .optional(),
    date: dateSchema.nullable().optional(),
    merchant: z.string().trim().max(200).nullable().optional(),
    type: transactionTypeSchema.nullable().optional(),
    categoryId: z.string().uuid("categoryId must be a uuid").nullable().optional(),
  })
  .refine((o) => Object.keys(o).length > 0, "at least one review field is required");

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

// Statement import confirm: manual category assignment per READY candidate.
// Keyed by deterministic fingerprint (rowIndex is per-pocket, not unique).
// Exact-set matching against the parser output is enforced in the handler.
export const confirmImportSchema = z.object({
  candidates: z.array(
    z.object({
      fingerprint: z
        .string()
        .regex(/^[0-9a-f]{64}$/, "fingerprint must be sha256 hex"),
      categoryId: z.string().uuid("categoryId must be a uuid"),
    }),
  ),
});

export const authSchema = z.object({  email: z
    .string()
    .trim()
    .toLowerCase()
    .email("valid email is required")
    .max(255),
  password: z
    .string()
    .min(8, "password must be at least 8 characters")
    .max(128),
});

export type CreateCategoryInput = z.infer<typeof createCategorySchema>;
export type CreateTransactionInput = z.infer<typeof createTransactionSchema>;

import { z } from "zod";
import { dateSchema, transactionTypeSchema } from "../../validate.js";

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

export type CreateTransactionInput = z.infer<typeof createTransactionSchema>;

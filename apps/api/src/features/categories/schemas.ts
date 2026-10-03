import { z } from "zod";

// API uses lowercase types; mapped to Prisma enums in routes.
export const categoryTypeSchema = z.enum(["income", "expense", "both"]);

export const listCategoriesSchema = z.object({
  type: categoryTypeSchema.optional(),
});

export const createCategorySchema = z.object({
  name: z.string().trim().min(1, "name is required").max(100),
  type: categoryTypeSchema,
});

export type CreateCategoryInput = z.infer<typeof createCategorySchema>;

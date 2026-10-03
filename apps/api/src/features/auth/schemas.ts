import { z } from "zod";

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

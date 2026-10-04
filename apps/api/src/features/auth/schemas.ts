import { z } from "zod";

// Reserved names can never be registered (the backfill script avoids
// assigning them too). Checked after trim+lowercase, so this stays
// lowercase-only.
export const RESERVED_USERNAMES = new Set([
  "admin",
  "root",
  "superadmin",
  "support",
  "api",
  "null",
  "undefined",
]);

const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email("valid email is required")
  .max(255);

const passwordSchema = z
  .string()
  .min(8, "password must be at least 8 characters")
  .max(128);

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^[a-z0-9_]{3,20}$/,
    "username must be 3-20 lowercase letters, numbers, or underscores",
  )
  .refine((u) => !RESERVED_USERNAMES.has(u), "username is reserved");

// Register and login deliberately use separate schemas: register collects
// email+username+name, while login takes a single identifier (email or
// username). Unknown keys are still stripped, so a client-sent "role"
// is ignored exactly like before.
export const registerSchema = z.object({
  email: emailSchema,
  username: usernameSchema,
  name: z
    .string()
    .trim()
    .min(1, "name must not be empty")
    .max(100, "name is too long"),
  password: passwordSchema,
});

export const loginSchema = z.object({
  identifier: z
    .string()
    .trim()
    .toLowerCase()
    .min(1, "identifier is required")
    .max(255),
  password: passwordSchema,
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;

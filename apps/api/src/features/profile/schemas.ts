import { z } from "zod";

// Unknown keys (email, role, ...) are stripped: they are always ignored.
export const updateProfileSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "name must not be empty")
    .max(100, "name is too long")
    .nullable()
    .optional(),
});

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

// Same password rule as register/login (authSchema): 8..128 characters.
export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "current password is required").max(128),
    newPassword: z
      .string()
      .min(8, "password must be at least 8 characters")
      .max(128),
  })
  .superRefine((v, ctx) => {
    if (v.currentPassword === v.newPassword)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "new password must be different",
        path: ["newPassword"],
      });
  });

export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

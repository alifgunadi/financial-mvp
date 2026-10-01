import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  PORT: z.coerce.number().int().positive().default(3001),
  // Vision extraction only. Optional at boot so existing flows work
  // without a key; /api/receipts/:id/extract returns 503 when unset.
  GEMINI_API_KEY: z.string().min(1).optional(),
  GEMINI_MODEL: z.string().min(1).default("gemini-2.0-flash"),
  // Explicit frontend origin(s) for credentialed CORS (never "*" with cookies).
  // Comma-separated allowlist, e.g. WEB_ORIGIN=http://localhost:7364,http://192.168.1.59:7364
  WEB_ORIGIN: z
    .string()
    .min(1)
    .default("http://localhost:7364,http://127.0.0.1:7364"),
});

export const env = envSchema.parse(process.env);

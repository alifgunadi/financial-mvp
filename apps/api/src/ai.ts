import { z } from "zod";
import { env } from "./env.js";

// Gemini Vision extraction (plain fetch, no SDK).
// Returns a CANDIDATE only. Never creates or mutates a Transaction.

export interface ExtractionCandidate {
  amount: number | null; // whole IDR units, integer > 0, or null
  date: string | null; // YYYY-MM-DD, or null
  merchant: string | null;
  type: "EXPENSE" | "INCOME" | null;
  category: string | null; // raw suggestion, never auto-creates a Category
}

export type AiErrorType =
  | "NOT_CONFIGURED"
  | "TIMEOUT"
  | "NETWORK"
  | "HTTP"
  | "EMPTY"
  | "PARSE"
  | "INVALID";

// Internal diagnostic detail. Carried on AiError for the centralized
// logger only — never sent to the frontend. Contains no secrets:
// no API key, headers, cookies, image/base64, or request payload.
export interface AiDetail {
  provider: "gemini";
  model: string;
  type: AiErrorType;
  durationMs: number;
  providerStatus?: number;
  // Sanitized provider error summary (bounded, single-line).
  providerMessage?: string;
}

export class AiError extends Error {
  constructor(public status: number, message: string, public detail?: AiDetail) {
    super(message);
    this.name = "AiError";
  }
}

const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  });

// Per-field .catch(null): one bad field nulls that field, never the
// whole candidate. A non-object top level still throws (malformed).
const candidateSchema = z.object({
  amount: z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .nullable()
    .catch(null),
  date: calendarDate.nullable().catch(null),
  merchant: z.string().nullable().catch(null),
  type: z.unknown().nullable().catch(null),
  category: z.string().nullable().catch(null),
});

function normalizeText(v: string | null, max: number): string | null {
  if (typeof v !== "string") return null;
  const clean = v.trim().replace(/\s+/g, " ");
  return clean ? clean.slice(0, max) : null;
}

// Bounded single-line summary of a provider error body. Prefers the safe
// error.message/code fields of a JSON error envelope over the raw body;
// falls back to truncated text. The provider body is never combined with
// request material here, so no header/image can leak through it — and as
// a final guard the configured key value itself is redacted in case a
// provider ever echoes request material back in an error payload.
function sanitizeProviderBody(body: string): string {
  const key = env.GEMINI_API_KEY;
  const scrubbed =
    key && body.includes(key) ? body.split(key).join("[redacted]") : body;  try {
    const parsed: unknown = JSON.parse(scrubbed);
    const err =
      typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>).error
        : undefined;
    const src =
      typeof err === "object" && err !== null
        ? (err as Record<string, unknown>)
        : typeof parsed === "object" && parsed !== null
          ? (parsed as Record<string, unknown>)
          : undefined;
    if (src) {
      const parts: string[] = [];
      for (const k of ["code", "status", "message"]) {
        const v = src[k];
        if (typeof v === "string" || typeof v === "number") parts.push(`${k}=${v}`);
      }
      if (parts.length > 0) return parts.join(" ").replace(/\s+/g, " ").slice(0, 500);
    }
  } catch {
    // Not JSON: fall through to truncated text.
  }
  return scrubbed.replace(/\s+/g, " ").trim().slice(0, 500);
}

const PROMPT = `You read an Indonesian payment receipt photo and return a single JSON object, nothing else.
RULES:
- If a value is not clearly visible, use null. Never invent amount, date, merchant, category, or type.
- amount: the grand total / final total actually printed on the receipt, as whole Indonesian Rupiah (Rp50.000 -> 50000, Rp125.500 -> 125500). If subtotal + tax + total are shown, use the grand total. If no trustworthy total is visible, use null. Positive integer only, never a decimal.
- date: the transaction date as YYYY-MM-DD. If the year cannot be determined reliably, use null. Never guess the year.
- merchant: the store/merchant name as printed, or null.
- type: "EXPENSE" for an ordinary purchase of goods/services, "INCOME" only with clear evidence (e.g. salary slip, incoming transfer receipt), otherwise null.
- category: a short generic suggestion (e.g. "Food", "Transport", "Groceries"), or null.
Return exactly: {"amount": number|null, "date": string|null, "merchant": string|null, "type": "EXPENSE"|"INCOME"|null, "category": string|null}`;

export async function extractReceipt(
  image: Buffer,
  mimeType: string,
): Promise<ExtractionCandidate> {
  const started = Date.now();
  const detail = (
    type: AiErrorType,
    extra?: Pick<AiDetail, "providerStatus" | "providerMessage">,
  ): AiDetail => ({
    provider: "gemini",
    model: env.GEMINI_MODEL,
    type,
    durationMs: Date.now() - started,
    ...extra,
  });
  if (!env.GEMINI_API_KEY)
    throw new AiError(503, "AI provider unavailable", detail("NOT_CONFIGURED"));
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_MODEL}:generateContent`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: PROMPT },
              { inlineData: { mimeType, data: image.toString("base64") } },
            ],
          },
        ],
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: {
              amount: { type: "INTEGER", nullable: true },
              date: { type: "STRING", nullable: true },
              merchant: { type: "STRING", nullable: true },
              type: { type: "STRING", nullable: true },
              category: { type: "STRING", nullable: true },
            },
            required: ["amount", "date", "merchant", "type", "category"],
          },
        },
      }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    if (e instanceof Error && e.name === "TimeoutError")
      throw new AiError(504, "AI provider timeout", detail("TIMEOUT"));
    throw new AiError(502, "AI provider unreachable", detail("NETWORK"));
  }
  if (!res.ok) {
    // Capture status + sanitized body BEFORE throwing: this is the
    // diagnostic evidence the old code discarded. 429 is transient
    // (client may retry later → 503); other statuses stay 502.
    const raw = await res.text().catch(() => "");
    const providerMessage = sanitizeProviderBody(raw) || undefined;
    if (res.status === 429)
      throw new AiError(503, "AI provider busy", detail("HTTP", {
        providerStatus: res.status,
        providerMessage,
      }));
    throw new AiError(502, "AI provider error", detail("HTTP", {
      providerStatus: res.status,
      providerMessage,
    }));
  }

  const data = (await res.json().catch(() => null)) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  } | null;
  const text = data?.candidates?.[0]?.content?.parts
    ?.map((p) => p.text ?? "")
    .join("")
    .trim();
  if (!text) throw new AiError(502, "AI provider returned no result", detail("EMPTY"));

  let json: unknown;
  try {
    json = JSON.parse(text.replace(/^```(json)?/i, "").replace(/```$/, "").trim());
  } catch {
    throw new AiError(502, "AI returned malformed response", detail("PARSE"));
  }
  const parsed = candidateSchema.safeParse(json);
  if (!parsed.success) throw new AiError(502, "AI returned malformed response", detail("INVALID"));

  const t =
    typeof parsed.data.type === "string"
      ? parsed.data.type.trim().toUpperCase()
      : null;
  return {
    amount: parsed.data.amount,
    date: parsed.data.date,
    merchant: normalizeText(parsed.data.merchant, 200),
    type: t === "EXPENSE" || t === "INCOME" ? t : null,
    category: normalizeText(parsed.data.category, 100),
  };
}

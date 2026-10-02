import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import cors from "cors";
import express from "express";
import multer from "multer";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { env } from "./env.js";
import { db } from "./db.js";
import {
  deleteReceiptFile,
  receiptFilePath,
  saveReceiptFile,
} from "./receiptStore.js";
import { AiError, extractReceipt } from "./ai.js";
import { BluError, parseBluPdf } from "./statements/bluParse.js";
import { PdfExtractError } from "./statements/pdfExtract.js";
import {
  summarizeCandidates,
  toImportCandidates,
} from "./statements/bluSemantic.js";
import { logError, logInfo, prismaCause, requestContext, sendError } from "./logger.js";
import {
  createSession,
  hashPassword,
  requireAuth,
  resolveRole,
  revokeSession,
  verifyPassword,
} from "./auth.js";
import {
  authSchema,
  confirmImportSchema,
  createCategorySchema,
  createImportSchema,
  createTransactionSchema,
  listCategoriesSchema,
  listTransactionsSchema,
  summarySchema,
  updateReceiptSchema,
} from "./validate.js";

const app = express();
// Centralized CORS (the only CORS config in the app): explicit origin
// allowlist. No per-endpoint CORS, no manual ACAO headers. Authentication
// travels in the Authorization header, so credentialed CORS is off.
const allowedOrigins = env.WEB_ORIGIN.split(",")
  .map((s) => s.trim().replace(/\/+$/, ""))
  .filter(Boolean);
app.use(cors({ origin: allowedOrigins }));
app.use(express.json());
app.use(requestContext);

function toDb<T extends string>(t: T): Uppercase<T> {
  return t.toUpperCase() as Uppercase<T>;
}
const toApi = (t: string) => t.toLowerCase();
const toDateString = (d: Date) => d.toISOString().slice(0, 10);

function badRequest(
  res: express.Response,
  req: express.Request,
  error: unknown,
  operation: string,
) {
  const message =
    error instanceof z.ZodError
      ? error.issues.map((i) => i.message).join("; ")
      : "invalid request";
  sendError(res, req, {
    status: 400,
    code: "VALIDATION_ERROR",
    message,
    operation,
  });
}

function unauthorized(res: express.Response, req: express.Request) {
  sendError(res, req, {
    status: 401,
    code: "AUTHENTICATION_ERROR",
    message: "authentication required",
  });
}

// Prisma Transaction with included category → API shape.
// BigInt stays integer end-to-end (Number() of a BigInt, never float math).
type TxWithCategory = Prisma.TransactionGetPayload<{
  include: { category: true };
}>;

function toApiTransaction(t: TxWithCategory) {
  return {
    id: t.id,
    type: toApi(t.type),
    amount: Number(t.amount),
    date: toDateString(t.date),
    note: t.note,
    merchant: t.merchant,
    category: {
      id: t.category.id,
      name: t.category.name,
      type: toApi(t.category.type),
    },
    createdAt: t.createdAt.toISOString(),
  };
}

// Prisma Receipt with the reviewer's chosen category → Stage 4 shape.
// Never exposes filePath, userId, sessions, or provider internals.
type ReceiptWithSuggestion = Prisma.ReceiptGetPayload<{
  include: { suggestedCategory: true };
}>;

// rawAiJson holds only the successful extraction candidate (written by
// the extract handler). Anything else shaped → null, never an error.
function toAiOriginal(raw: unknown) {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const amount =
    typeof o.amount === "number" &&
      Number.isInteger(o.amount) &&
      (o.amount as number) > 0
      ? (o.amount as number)
      : null;
  const date = typeof o.date === "string" ? (o.date as string) : null;
  const merchant = typeof o.merchant === "string" ? (o.merchant as string) : null;
  const type =
    o.type === "EXPENSE" || o.type === "INCOME" ? toApi(o.type as string) : null;
  const category = typeof o.category === "string" ? (o.category as string) : null;
  return { amount, date, merchant, type, category };
}

function toApiReceipt(r: ReceiptWithSuggestion) {
  return {
    id: r.id,
    status: toApi(r.status),
    extraction: {
      amount: r.extractedAmount === null ? null : Number(r.extractedAmount),
      date: r.extractedDate ? toDateString(r.extractedDate) : null,
      merchant: r.extractedMerchant,
      type: r.extractedType ? toApi(r.extractedType) : null,
      category: r.extractedCategory,
    },
    suggestedCategory: r.suggestedCategory
      ? {
        id: r.suggestedCategory.id,
        name: r.suggestedCategory.name,
        type: toApi(r.suggestedCategory.type),
      }
      : null,
    aiOriginal: toAiOriginal(r.rawAiJson),
    extractedAt: r.extractedAt ? r.extractedAt.toISOString() : null,
    error: r.error,
  };
}

// Prisma ImportBatch → API shape. Never exposes filePath or userId.
type ImportBatchRow = Prisma.ImportBatchGetPayload<Record<keyof never, never>>;

function toApiImport(b: ImportBatchRow) {
  return {
    id: b.id,
    fileHash: b.fileHash,
    originalName: b.originalName,
    mimeType: b.mimeType,
    size: b.size,
    bankId: b.bankId,
    statementFrom: b.statementFrom ? toDateString(b.statementFrom) : null,
    statementTo: b.statementTo ? toDateString(b.statementTo) : null,
    status: toApi(b.status),
    error: b.error,
    createdAt: b.createdAt.toISOString(),
  };
}

// ---------- auth ----------

// Dummy hash so unknown emails cost the same bcrypt work as real ones
// (no timing oracle for account existence).
const DUMMY_HASH = "$2b$10$Elt6aKm7F08vGituLc90iumw95Es6Pa50sTWlTFe/Mw9KS7h1cCHK";

app.post("/api/auth/register", async (req, res) => {
  const parsed = authSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, req, parsed.error, "register_user");
  // NOTE: authSchema strips unknown keys, so a client-sent "role" is ignored.
  try {
    const existingSuperadmin = await db.user.findFirst({
      where: { role: "SUPERADMIN" },
      select: { id: true },
    });
    const role = resolveRole(parsed.data.email, env.SUPERADMIN_EMAIL, existingSuperadmin !== null);
    const user = await db.user.create({
      data: {
        email: parsed.data.email,
        passwordHash: await hashPassword(parsed.data.password),
        role,
      },
    });
    // No session here: registration never authenticates. The user logs in
    // separately, which is the only place a session is created.
    logInfo({ req, operation: "register_user", message: `user registered id=${user.id}` });
    res.status(201).json({ id: user.id, email: user.email, role });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")
      return sendError(res, req, {
        status: 409,
        code: "CONFLICT_ERROR",
        message: "email already registered",
        operation: "register_user",
        causeCode: prismaCause(e),
      });
    sendError(res, req, {
      status: 500,
      code: "DATABASE_ERROR",
      message: "failed to register",
      operation: "register_user",
      causeCode: prismaCause(e),
      err: e,
    });
  }
});

app.post("/api/auth/login", async (req, res) => {
  const parsed = authSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, req, parsed.error, "login_user");
  const user = await db.user
    .findUnique({ where: { email: parsed.data.email } })
    .catch(() => null);
  const ok = await verifyPassword(
    parsed.data.password,
    user ? user.passwordHash : DUMMY_HASH,
  ).catch(() => false);
  if (!user || !ok)
    return sendError(res, req, {
      status: 401,
      code: "AUTHENTICATION_ERROR",
      message: "invalid email or password",
      operation: "login_user",
    });
  try {
    const role = user.role as "CLIENT" | "SUPERADMIN";
    const sessionToken = await createSession({ id: user.id, email: user.email, role });
    logInfo({ req, operation: "login_user", message: `user logged in id=${user.id}` });
    res.json({ id: user.id, email: user.email, role, sessionToken });
  } catch (e) {
    sendError(res, req, {
      status: 500,
      code: "DATABASE_ERROR",
      message: "failed to log in",
      operation: "login_user",
      causeCode: prismaCause(e),
      err: e,
    });
  }
});

app.post("/api/auth/logout", async (req, res) => {
  await revokeSession(req);
  res.json({ ok: true });
});

app.get("/api/auth/me", requireAuth, (req, res) => {
  if (!req.user) return unauthorized(res, req);
  res.json({ id: req.user.id, email: req.user.email, role: req.user.role });
});

// ---------- categories ----------

app.get("/api/categories", requireAuth, (req, res) => {
  const parsed = listCategoriesSchema.safeParse(req.query);
  if (!parsed.success) return badRequest(res, req, parsed.error, "list_categories");
  if (!req.user) return unauthorized(res, req);
  const userId = req.user.id;
  db.category
    .findMany({
      where: {
        userId,
        ...(parsed.data.type ? { type: toDb(parsed.data.type) } : {}),
      },
      orderBy: { name: "asc" },
    })
    .then((rows) =>
      res.json(
        rows.map((c) => ({ id: c.id, name: c.name, type: toApi(c.type) })),
      ),
    )
    .catch((e) =>
      sendError(res, req, {
        status: 500,
        code: "DATABASE_ERROR",
        message: "failed to list categories",
        operation: "list_categories",
        causeCode: prismaCause(e),
        err: e,
      }),
    );
});

app.post("/api/categories", requireAuth, async (req, res) => {
  const parsed = createCategorySchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, req, parsed.error, "create_category");
  if (!req.user) return unauthorized(res, req);
  try {
    const c = await db.category.create({
      data: {
        name: parsed.data.name,
        type: toDb(parsed.data.type),
        userId: req.user.id,
      },
    });
    res.status(201).json({ id: c.id, name: c.name, type: toApi(c.type) });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")
      return sendError(res, req, {
        status: 409,
        code: "CONFLICT_ERROR",
        message: "category name already exists",
        operation: "create_category",
        causeCode: prismaCause(e),
      });
    sendError(res, req, {
      status: 500,
      code: "DATABASE_ERROR",
      message: "failed to create category",
      operation: "create_category",
      causeCode: prismaCause(e),
      err: e,
    });
  }
});

// ---------- transactions ----------

app.get("/api/transactions", requireAuth, async (req, res) => {
  const parsed = listTransactionsSchema.safeParse(req.query);
  if (!parsed.success) return badRequest(res, req, parsed.error, "list_transactions");
  if (!req.user) return unauthorized(res, req);
  const { type, categoryId, from, to, limit, offset } = parsed.data;
  const where: Prisma.TransactionWhereInput = {
    userId: req.user.id,
    ...(type ? { type: toDb(type) } : {}),
    ...(categoryId ? { categoryId } : {}),
    ...(from || to
      ? {
        date: {
          ...(from ? { gte: new Date(`${from}T00:00:00Z`) } : {}),
          ...(to ? { lte: new Date(`${to}T00:00:00Z`) } : {}),
        },
      }
      : {}),
  };
  try {
    const [total, rows] = await Promise.all([
      db.transaction.count({ where }),
      db.transaction.findMany({
        where,
        include: { category: true },
        orderBy: [{ date: "desc" }, { createdAt: "desc" }],
        take: limit,
        skip: offset,
      }),
    ]);
    res.json({
      data: rows.map(toApiTransaction),
      total,
    });
  } catch (e) {
    sendError(res, req, {
      status: 500,
      code: "DATABASE_ERROR",
      message: "failed to list transactions",
      operation: "list_transactions",
      causeCode: prismaCause(e),
      err: e,
    });
  }
});

app.post("/api/transactions", requireAuth, async (req, res) => {
  const parsed = createTransactionSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, req, parsed.error, "create_transaction");
  if (!req.user) return unauthorized(res, req);
  const userId = req.user.id;
  const { type, amount, date, categoryId, note, merchant } = parsed.data;
  // Ownership check: the category must belong to the caller.
  // Same "not found" message as a missing id: no existence leak.
  const category = await db.category
    .findFirst({ where: { id: categoryId, userId }, select: { id: true } })
    .catch(() => null);
  if (!category)
    return sendError(res, req, {
      status: 400,
      code: "VALIDATION_ERROR",
      message: "category not found",
      operation: "create_transaction",
    });
  try {
    const t = await db.transaction.create({
      data: {
        type: toDb(type),
        amount: BigInt(amount),
        date: new Date(`${date}T00:00:00Z`),
        note: note || null,
        merchant: merchant || null,
        source: "MANUAL",
        userId,
        categoryId,
      },
      include: { category: true },
    });
    res.status(201).json(toApiTransaction(t));
  } catch (e) {
    sendError(res, req, {
      status: 500,
      code: "DATABASE_ERROR",
      message: "failed to create transaction",
      operation: "create_transaction",
      causeCode: prismaCause(e),
      err: e,
    });
  }
});

// ---------- dashboard ----------

// Spending pace helpers (dashboard only). Calendar-safe by construction:
// pure UTC calendar dates, never division of local timestamps.
function parseCalendarDate(s: string): number {
  const [y, m, d] = s.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

// Daily spending guide from existing Transaction aggregates only.
// Null when not computable (unbounded or ended period). Status describes
// the period balance, never just today's overspend.
function toSpendingPace(opts: {
  asOf: string;
  to: string | null;
  totalIncome: number;
  totalExpense: number;
  spentToday: number;
}):
  | {
    asOf: string;
    remainingDays: number;
    recommendedMaxPerDay: number;
    spentToday: number;
    remainingToday: number;
    status: string;
  }
  | null {
  const { asOf, to, totalIncome, totalExpense, spentToday } = opts;
  if (to === null) return null; // unbounded: no end date to pace against
  const remainingDays =
    Math.round((parseCalendarDate(to) - parseCalendarDate(asOf)) / 86_400_000) + 1;
  if (remainingDays <= 0) return null; // period ended: never divide by zero
  const balance = totalIncome - totalExpense;
  if (balance < 0)
    return {
      asOf,
      remainingDays,
      recommendedMaxPerDay: 0,
      spentToday,
      remainingToday: 0 - spentToday,
      status: "over_budget",
    };
  // Floor: daily maxima over the remaining days can never exceed balance.
  const recommendedMaxPerDay = Math.floor(balance / remainingDays);
  const status = totalIncome === 0 && totalExpense === 0 ? "no_data" : "on_track";
  return {
    asOf,
    remainingDays,
    recommendedMaxPerDay,
    spentToday,
    remainingToday: recommendedMaxPerDay - spentToday,
    status,
  };
}

app.get("/api/dashboard/summary", requireAuth, async (req, res) => {
  const parsed = summarySchema.safeParse(req.query);
  if (!parsed.success) return badRequest(res, req, parsed.error, "dashboard_summary");
  if (!req.user) return unauthorized(res, req);
  const userId = req.user.id;
  const { from, to } = parsed.data;
  const dateRange =
    from || to
      ? {
        date: {
          ...(from ? { gte: new Date(`${from}T00:00:00Z`) } : {}),
          ...(to ? { lte: new Date(`${to}T00:00:00Z`) } : {}),
        },
      }
      : {};
  try {
    // All math in SQL (SUM / GROUP BY), scoped to the caller. Only aggregates cross the wire.
    // spentToday is deliberately outside the period filter: it is always
    // "today", while the period itself is user-selected (may be past/future).
    const asOf = new Date().toISOString().slice(0, 10);
    const todayStart = new Date(`${asOf}T00:00:00Z`);
    const [income, expense, groups, recent, spent] = await Promise.all([
      db.transaction.aggregate({
        _sum: { amount: true },
        where: { ...dateRange, userId, type: "INCOME" },
      }),
      db.transaction.aggregate({
        _sum: { amount: true },
        where: { ...dateRange, userId, type: "EXPENSE" },
      }),
      db.transaction.groupBy({
        by: ["categoryId"],
        _sum: { amount: true },
        where: { ...dateRange, userId, type: "EXPENSE" },
      }),
      db.transaction.findMany({
        where: { ...dateRange, userId },
        include: { category: true },
        orderBy: [{ date: "desc" }, { createdAt: "desc" }],
        take: 5,
      }),
      db.transaction.aggregate({
        _sum: { amount: true },
        where: {
          userId,
          type: "EXPENSE",
          date: { gte: todayStart, lte: todayStart },
        },
      }),
    ]);
    const categories = groups.length
      ? await db.category.findMany({
        where: { userId, id: { in: groups.map((g) => g.categoryId) } },
      })
      : [];
    const nameOf = new Map(categories.map((c) => [c.id, c.name]));
    const totalIncome = Number(income._sum.amount ?? 0);
    const totalExpense = Number(expense._sum.amount ?? 0);
    res.json({
      from: from ?? null,
      to: to ?? null,
      totalIncome,
      totalExpense,
      // Period net flow (income − expense), NOT an account balance.
      balance: totalIncome - totalExpense, expenseByCategory: groups
        .map((g) => ({
          categoryId: g.categoryId,
          name: nameOf.get(g.categoryId) ?? "Unknown",
          total: Number(g._sum.amount ?? 0),
        }))
        .sort((a, b) => b.total - a.total),
      recent: recent.map(toApiTransaction),
      // Additive daily guide (null when unbounded/ended). Existing fields above unchanged.
      spendingPace: toSpendingPace({
        asOf,
        to: to ?? null,
        totalIncome,
        totalExpense,
        spentToday: Number(spent._sum.amount ?? 0),
      }),
    });
  } catch (e) {
    sendError(res, req, {
      status: 500,
      code: "DATABASE_ERROR",
      message: "failed to load dashboard summary",
      operation: "dashboard_summary",
      causeCode: prismaCause(e),
      err: e,
    });
  }
});

// ---------- receipts (upload only, no AI yet) ----------

// Max 5MB: receipts are phone photos, larger files are rejected outright.
const MAX_RECEIPT_BYTES = 5 * 1024 * 1024;

// Extraction quota: max attempts per user per rolling window. Counted via
// ExtractionAttempt rows (one per call, created before the Gemini call),
// so re-extracting the same receipt still counts. Plain constants (not
// env): tuning them is a code change, like the other receipt caps here.
const EXTRACT_QUOTA_MAX = 20;
const EXTRACT_QUOTA_WINDOW_MS = 24 * 60 * 60 * 1000;

const RECEIPT_TYPES: Record<string, { exts: string[]; ext: string }> = {
  "image/jpeg": { exts: [".jpg", ".jpeg"], ext: ".jpg" },
  "image/png": { exts: [".png"], ext: ".png" },
  "image/webp": { exts: [".webp"], ext: ".webp" },
};

// Client MIME/extension are hints only; magic bytes decide the real type.
function sniffImage(buf: Buffer): string | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)
    return "image/jpeg";
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  )
    return "image/png";
  if (
    buf.length >= 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  )
    return "image/webp";
  return null;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_RECEIPT_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    const known = RECEIPT_TYPES[file.mimetype];
    const ext = file.originalname.slice(file.originalname.lastIndexOf(".")).toLowerCase();
    if (!known || !known.exts.includes(ext))
      return cb(new Error("unsupported file type (jpeg, png, or webp only)"));
    cb(null, true);
  },
});

interface UploadedFile {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
  size: number;
}

app.post("/api/receipts", requireAuth, (req, res) => {
  upload.single("file")(req, res, async (err: unknown) => {
    if (!req.user) return unauthorized(res, req);
    const userId = req.user.id;
    if (err) {
      if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE")
        return sendError(res, req, {
          status: 413,
          code: "FILE_ERROR",
          message: "file too large (max 5MB)",
          operation: "receipt_upload",
        });
      const message = err instanceof Error ? err.message : "invalid upload";
      return sendError(res, req, {
        status: 400,
        code: "FILE_ERROR",
        message,
        operation: "receipt_upload",
      });
    }
    const file = (req as { file?: UploadedFile }).file;
    if (!file || file.size === 0)
      return sendError(res, req, {
        status: 400,
        code: "FILE_ERROR",
        message: "file is required",
        operation: "receipt_upload",
      });
    const sniffed = sniffImage(file.buffer);
    if (!sniffed || sniffed !== file.mimetype)
      return sendError(res, req, {
        status: 400,
        code: "FILE_ERROR",
        message: "unsupported file type",
        operation: "receipt_upload",
      });
    // Metadata only; the original name is never used as a path.
    const originalName =
      Buffer.from(file.originalname, "latin1").toString("utf8").trim().slice(0, 255) ||
      "receipt";
    const storedName = await saveReceiptFile(RECEIPT_TYPES[sniffed].ext, file.buffer).catch(
      () => null,
    );
    if (!storedName)
      return sendError(res, req, {
        status: 500,
        code: "FILE_ERROR",
        message: "failed to store receipt",
        operation: "receipt_upload",
      });
    try {
      // Upload only: status stays UPLOADED, no Transaction is created.
      const r = await db.receipt.create({
        data: {
          filePath: `uploads/${storedName}`,
          originalName,
          mimeType: sniffed,
          size: file.size,
          userId,
        },
      });
      res.status(201).json({
        id: r.id,
        filename: r.originalName,
        mimeType: r.mimeType,
        size: r.size,
        createdAt: r.createdAt.toISOString(),
      });
    } catch (e) {
      await deleteReceiptFile(storedName);
      sendError(res, req, {
        status: 500,
        code: "DATABASE_ERROR",
        message: "failed to save receipt",
        operation: "receipt_upload",
        causeCode: prismaCause(e),
        err: e,
      });
    }
  });
});

app.post("/api/receipts/:id/extract", requireAuth, async (req, res) => {
  const parsed = z.object({ id: z.string().uuid() }).safeParse(req.params);
  if (!parsed.success) return badRequest(res, req, parsed.error, "receipt_extract");
  if (!req.user) return unauthorized(res, req);
  // Scoped lookup: another user's receipt reads as not found (no leak).
  const receipt = await db.receipt
    .findFirst({ where: { id: parsed.data.id, userId: req.user.id } })
    .catch(() => null);
  if (!receipt)
    return sendError(res, req, {
      status: 404,
      code: "NOT_FOUND_ERROR",
      message: "receipt not found",
      operation: "receipt_extract",
    });
  if (receipt.status === "CONFIRMED")
    return sendError(res, req, {
      status: 409,
      code: "CONFLICT_ERROR",
      message: "receipt already confirmed",
      operation: "receipt_extract",
    });
  if (!env.GEMINI_API_KEY)
    return sendError(res, req, {
      status: 503,
      code: "AI_ERROR",
      message: "AI provider unavailable",
      operation: "receipt_extract",
    });
  // Quota: one ExtractionAttempt row per call, created BEFORE the Gemini
  // call so re-extracting the same receipt still counts. Requests already
  // known to fail (unknown id, CONFIRMED, no API key) never reach here.
  // try/catch (not .catch): also covers a stale Prisma client where the
  // delegate itself is missing. Refuse closed on failure: an unrecorded
  // attempt must not become a free Gemini call.
  const windowStart = new Date(Date.now() - EXTRACT_QUOTA_WINDOW_MS);
  try {
    await db.extractionAttempt.create({ data: { userId: req.user.id } });
  } catch (e) {
    return sendError(res, req, {
      status: 503,
      code: "DATABASE_ERROR",
      message: "extraction quota unavailable",
      operation: "receipt_extract",
      causeCode: prismaCause(e),
      err: e,
    });
  }
  const attempts = await db.extractionAttempt
    .count({ where: { userId: req.user.id, createdAt: { gte: windowStart } } })
    .catch(() => 0);
  if (attempts > EXTRACT_QUOTA_MAX) {
    // Oldest in-window attempt decides when a slot frees up; second query
    // only on the reject path. Without DB proof, fall back to the window.
    const oldest = await db.extractionAttempt
      .findFirst({
        where: { userId: req.user.id, createdAt: { gte: windowStart } },
        orderBy: { createdAt: "asc" },
        select: { createdAt: true },
      })
      .catch(() => null);
    const retryAfter =
      oldest?.createdAt == null
        ? EXTRACT_QUOTA_WINDOW_MS / 1000
        : Math.min(
          EXTRACT_QUOTA_WINDOW_MS / 1000,
          Math.max(
            1,
            Math.ceil(
              (oldest.createdAt.getTime() + EXTRACT_QUOTA_WINDOW_MS - Date.now()) / 1000,
            ),
          ),
        );
    res.setHeader("Retry-After", String(retryAfter));
    return sendError(res, req, {
      status: 429,
      code: "RATE_LIMIT_ERROR",
      message: "extraction quota exceeded, try again later",
      operation: "receipt_extract",
    });
  }
  // Opportunistic janitor: drop attempts already outside every window.
  // Fire-and-forget; a failed cleanup only leaves rows for the next call.
  void db.extractionAttempt
    .deleteMany({ where: { createdAt: { lt: windowStart } } })
    .catch(() => { });
  // basename: the stored path is never trusted as absolute or traversed.
  const image = await readFile(receiptFilePath(basename(receipt.filePath))).catch(
    () => null,
  );
  if (!image) {
    await db.receipt
      .update({
        where: { id: receipt.id },
        data: { status: "FAILED", error: "stored file missing" },
      })
      .catch(() => { });
    return sendError(res, req, {
      status: 404,
      code: "NOT_FOUND_ERROR",
      message: "stored file missing",
      operation: "receipt_extract",
    });
  }
  await db.receipt
    .update({
      where: { id: receipt.id },
      data: { status: "PROCESSING", error: null },
    })
    .catch(() => { });
  const started = Date.now();
  try {
    // Candidate only: updates this Receipt, never creates a Transaction.
    const c = await extractReceipt(image, receipt.mimeType);
    const updated = await db.receipt.update({
      where: { id: receipt.id },
      data: {
        status: "NEEDS_REVIEW",
        extractedAmount: c.amount === null ? null : BigInt(c.amount),
        extractedDate: c.date ? new Date(`${c.date}T00:00:00Z`) : null,
        extractedMerchant: c.merchant,
        extractedType: c.type,
        extractedCategory: c.category,
        extractedAt: new Date(),
        // Original AI candidate for Stage 4 review comparison.
        // Success only: provider errors never land here.
        rawAiJson: {
          amount: c.amount,
          date: c.date,
          merchant: c.merchant,
          type: c.type,
          category: c.category,
        },
        error: null,
      },
    });
    res.json({
      id: updated.id,
      status: toApi(updated.status),
      extraction: {
        amount: c.amount,
        date: c.date,
        merchant: c.merchant,
        type: c.type ? toApi(c.type) : null,
        category: c.category,
      },
    });
    logInfo({
      req,
      operation: "receipt_extract",
      message: `extraction saved receipt=${receipt.id} provider=gemini model=${env.GEMINI_MODEL} durationMs=${Date.now() - started}`,
    });
  } catch (err) {
    if (err instanceof AiError) {
      const d = err.detail;
      const diag = d
        ? `receipt=${receipt.id} provider=${d.provider} model=${d.model} durationMs=${Date.now() - started}` +
        (d.providerStatus !== undefined ? ` providerStatus=${d.providerStatus}` : "") +
        ` type=${d.type}` +
        (d.providerMessage ? ` providerBody="${d.providerMessage}"` : "")
        : `receipt=${receipt.id} durationMs=${Date.now() - started}`;
      await db.receipt
        .update({ where: { id: receipt.id }, data: { status: "FAILED", error: err.message } })
        .catch(() => { });
      sendError(res, req, {
        status: err.status,
        code: "AI_ERROR",
        message: err.message,
        operation: "receipt_extract",
        detail: diag,
        err,
      });
      return;
    }
    // Not an AiError: the failure came from our own DB/filesystem/code,
    // not the provider. Label INTERNAL_ERROR and keep the stack server-side.
    await db.receipt
      .update({ where: { id: receipt.id }, data: { status: "FAILED", error: "extraction failed" } })
      .catch(() => { });
    sendError(res, req, {
      status: 500,
      code: "INTERNAL_ERROR",
      message: "extraction failed",
      operation: "receipt_extract",
      detail: `receipt=${receipt.id} durationMs=${Date.now() - started}`,
      causeCode: prismaCause(err),
      err,
    });
  }
});

// ---------- receipts (Stage 4 review: read candidate) ----------

app.get("/api/receipts/:id", requireAuth, async (req, res) => {
  const parsed = z.object({ id: z.string().uuid() }).safeParse(req.params);
  if (!parsed.success) return badRequest(res, req, parsed.error, "get_receipt");
  if (!req.user) return unauthorized(res, req);
  // Scoped lookup: another user's receipt reads as not found (no leak).
  const receipt = await db.receipt
    .findFirst({
      where: { id: parsed.data.id, userId: req.user.id },
      include: { suggestedCategory: true },
    })
    .catch(() => null);
  if (!receipt)
    return sendError(res, req, {
      status: 404,
      code: "NOT_FOUND_ERROR",
      message: "receipt not found",
      operation: "get_receipt",
    });
  res.json(toApiReceipt(receipt));
});

// ---------- receipts (Stage 4 review: edit candidate) ----------

// Review-only: updates the candidate on a NEEDS_REVIEW receipt.
// Never touches rawAiJson/status/error/extractedAt, never creates a Transaction.
app.put("/api/receipts/:id", requireAuth, async (req, res) => {
  const paramParsed = z.object({ id: z.string().uuid() }).safeParse(req.params);
  if (!paramParsed.success)
    return badRequest(res, req, paramParsed.error, "update_receipt");
  const parsed = updateReceiptSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, req, parsed.error, "update_receipt");
  if (!req.user) return unauthorized(res, req);
  const userId = req.user.id;
  // Scoped lookup: another user's receipt reads as not found (no leak).
  const receipt = await db.receipt
    .findFirst({
      where: { id: paramParsed.data.id, userId },
      include: { suggestedCategory: true },
    })
    .catch(() => null);
  if (!receipt)
    return sendError(res, req, {
      status: 404,
      code: "NOT_FOUND_ERROR",
      message: "receipt not found",
      operation: "update_receipt",
    });
  if (receipt.status !== "NEEDS_REVIEW") {
    const message =
      receipt.status === "CONFIRMED"
        ? "receipt already confirmed"
        : receipt.status === "FAILED"
          ? "receipt extraction failed"
          : "receipt not ready for review";
    return sendError(res, req, {
      status: 409,
      code: "CONFLICT_ERROR",
      message,
      operation: "update_receipt",
    });
  }
  const { amount, date, merchant, type, categoryId } = parsed.data;
  // Ownership check: the category must belong to the caller (null clears).
  // Same "not found" message as a missing id: no existence leak.
  let suggestedCategoryId: string | null | undefined;
  if (categoryId !== undefined) {
    if (categoryId === null) {
      suggestedCategoryId = null;
    } else {
      const category = await db.category
        .findFirst({ where: { id: categoryId, userId }, select: { id: true } })
        .catch(() => null);
      if (!category)
        return sendError(res, req, {
          status: 400,
          code: "VALIDATION_ERROR",
          message: "category not found",
          operation: "update_receipt",
        });
      suggestedCategoryId = category.id;
    }
  }
  // Empty merchant clears to null; internal runs collapse (AI parity).
  const cleanMerchant =
    merchant === undefined
      ? undefined
      : typeof merchant === "string"
        ? merchant.replace(/\s+/g, " ") || null
        : null;
  try {
    const updated = await db.receipt.update({
      where: { id: receipt.id },
      data: {
        ...(amount !== undefined
          ? { extractedAmount: amount === null ? null : BigInt(amount) }
          : {}),
        ...(date !== undefined
          ? { extractedDate: date === null ? null : new Date(`${date}T00:00:00Z`) }
          : {}),
        ...(cleanMerchant !== undefined ? { extractedMerchant: cleanMerchant } : {}),
        ...(type !== undefined
          ? { extractedType: type === null ? null : toDb(type) }
          : {}),
        ...(suggestedCategoryId !== undefined
          ? { suggestedCategoryId }
          : {}),
      },
      include: { suggestedCategory: true },
    });
    logInfo({
      req,
      operation: "receipt_review",
      message: `review saved receipt=${receipt.id}`,
    });
    res.json(toApiReceipt(updated));
  } catch (e) {
    sendError(res, req, {
      status: 500,
      code: "DATABASE_ERROR",
      message: "failed to save review",
      operation: "update_receipt",
      causeCode: prismaCause(e),
      err: e,
    });
  }
});

// ---------- statement imports (foundation: upload + identity only) ----------

// Foundation only: records the uploaded PDF and its exact identity. No text
// extraction, no bank parsing, no Transaction creation happens here.

const MAX_STATEMENT_BYTES = 10 * 1024 * 1024;

const uploadImport = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_STATEMENT_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ext = file.originalname.slice(file.originalname.lastIndexOf(".")).toLowerCase();
    if (file.mimetype !== "application/pdf" || ext !== ".pdf")
      return cb(new Error("unsupported file type (pdf only)"));
    cb(null, true);
  },
});

// Client MIME/extension are hints only; the %PDF- magic decides.
function sniffPdf(buf: Buffer): boolean {
  return (
    buf.length >= 5 &&
    buf[0] === 0x25 && // %
    buf[1] === 0x50 && // P
    buf[2] === 0x44 && // D
    buf[3] === 0x46 && // F
    buf[4] === 0x2d // -
  );
}

function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

app.post("/api/imports", requireAuth, (req, res) => {
  uploadImport.single("file")(req, res, async (err: unknown) => {
    if (!req.user) return unauthorized(res, req);
    const userId = req.user.id;
    if (err) {
      if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE")
        return sendError(res, req, {
          status: 413,
          code: "FILE_ERROR",
          message: "file too large (max 10MB)",
          operation: "import_upload",
        });
      const message = err instanceof Error ? err.message : "invalid upload";
      return sendError(res, req, {
        status: 400,
        code: "FILE_ERROR",
        message,
        operation: "import_upload",
      });
    }
    const file = (req as { file?: UploadedFile }).file;
    if (!file || file.size === 0)
      return sendError(res, req, {
        status: 400,
        code: "FILE_ERROR",
        message: "file is required",
        operation: "import_upload",
      });
    if (!sniffPdf(file.buffer))
      return sendError(res, req, {
        status: 400,
        code: "FILE_ERROR",
        message: "file is not a valid PDF",
        operation: "import_upload",
      });
    // Explicit bank identifier only; absent stays null (unresolved).
    const bodyParsed = createImportSchema.safeParse(req.body ?? {});
    if (!bodyParsed.success)
      return badRequest(res, req, bodyParsed.error, "import_upload");
    const bankId = bodyParsed.data.bank ?? null;
    const fileHash = sha256Hex(file.buffer);
    // Fast path: same user + same bytes already imported. The DB unique
    // constraint below remains the final guard against concurrent races.
    const existing = await db.importBatch
      .findFirst({ where: { userId, fileHash }, select: { id: true } })
      .catch(() => null);
    if (existing)
      return sendError(res, req, {
        status: 409,
        code: "CONFLICT_ERROR",
        message: "statement already imported",
        operation: "import_upload",
      });
    // Metadata only; the original name is never used as a path.
    const originalName =
      Buffer.from(file.originalname, "latin1").toString("utf8").trim().slice(0, 255) ||
      "statement.pdf";
    const storedName = await saveReceiptFile(".pdf", file.buffer).catch(() => null);
    if (!storedName)
      return sendError(res, req, {
        status: 500,
        code: "FILE_ERROR",
        message: "failed to store statement",
        operation: "import_upload",
      });
    try {
      // Upload only: status stays UPLOADED, no Transaction is created.
      const b = await db.importBatch.create({
        data: {
          fileHash,
          filePath: `uploads/${storedName}`,
          originalName,
          mimeType: "application/pdf",
          size: file.size,
          bankId,
          userId,
        },
      });
      res.status(201).json(toApiImport(b));
    } catch (e) {
      await deleteReceiptFile(storedName);
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")
        return sendError(res, req, {
          status: 409,
          code: "CONFLICT_ERROR",
          message: "statement already imported",
          operation: "import_upload",
          causeCode: prismaCause(e),
        });
      sendError(res, req, {
        status: 500,
        code: "DATABASE_ERROR",
        message: "failed to save statement import",
        operation: "import_upload",
        causeCode: prismaCause(e),
        err: e,
      });
    }
  });
});

app.get("/api/imports/:id", requireAuth, async (req, res) => {
  const parsed = z.object({ id: z.string().uuid() }).safeParse(req.params);
  if (!parsed.success) return badRequest(res, req, parsed.error, "get_import");
  if (!req.user) return unauthorized(res, req);
  // Scoped lookup: another user's import reads as not found (no leak).
  const batch = await db.importBatch
    .findFirst({ where: { id: parsed.data.id, userId: req.user.id } })
    .catch(() => null);
  if (!batch)
    return sendError(res, req, {
      status: 404,
      code: "NOT_FOUND_ERROR",
      message: "import not found",
      operation: "get_import",
    });
  res.json(toApiImport(batch));
});

app.get("/api/imports/:id/preview", requireAuth, async (req, res) => {
  const parsed = z.object({ id: z.string().uuid() }).safeParse(req.params);
  if (!parsed.success) return badRequest(res, req, parsed.error, "preview_import");
  if (!req.user) return unauthorized(res, req);
  // Scoped lookup: another user's import reads as not found (no leak).
  const batch = await db.importBatch
    .findFirst({ where: { id: parsed.data.id, userId: req.user.id } })
    .catch(() => null);
  if (!batch)
    return sendError(res, req, {
      status: 404,
      code: "NOT_FOUND_ERROR",
      message: "import not found",
      operation: "preview_import",
    });
  // basename: the stored path is never trusted as absolute or traversed.
  const pdf = await readFile(receiptFilePath(basename(batch.filePath))).catch(
    () => null,
  );
  if (!pdf)
    return sendError(res, req, {
      status: 404,
      code: "NOT_FOUND_ERROR",
      message: "stored file missing",
      operation: "preview_import",
    });
  try {
    // Read-only: parse and classify only. No Transaction is created, the
    // batch is untouched, and no extraction quota is consumed (Gemini-free).
    const statement = await parseBluPdf(pdf);
    const candidates = toImportCandidates(statement);
    const summary = summarizeCandidates(candidates);
    res.json({
      batch: toApiImport(batch),
      bank: "blu",
      detected: statement.detected,
      statementPeriod: statement.statementPeriod,
      pockets: statement.pockets.map((p) => ({
        pocket: p.pocket,
        openingMinor: p.openingMinor === null ? null : Number(p.openingMinor),
        totalIncomeMinor: Number(p.totalIncomeMinor),
        totalExpenseMinor: Number(p.totalExpenseMinor),
        closingMinor: p.closingMinor === null ? null : Number(p.closingMinor),
        rowCount: p.rows.length,
        reconciled: p.reconciled,
        importable: p.importable,
        diagnostics: p.diagnostics,
      })),
      globalReconciled: statement.globalReconciled,
      importable: statement.importable,
      diagnostics: statement.diagnostics,
      summary: {
        ...summary,
        readyIncome: Number(summary.readyIncome),
        readyExpense: Number(summary.readyExpense),
      },
      candidates: candidates.map((c) => ({
        type: toApi(c.type),
        amount: Number(c.amount),
        date: c.date,
        merchant: c.merchant,
        note: c.note,
        reference: c.reference,
        fingerprint: c.fingerprint,
        disposition: toApi(c.disposition),
        pocket: c.pocket,
        rowIndex: c.rowIndex,
      })),
    });
  } catch (e) {
    if (e instanceof BluError)
      return sendError(res, req, {
        status: e.status,
        code: "VALIDATION_ERROR",
        message: e.message,
        operation: "preview_import",
      });
    if (e instanceof PdfExtractError)
      return sendError(res, req, {
        status: 400,
        code: "FILE_ERROR",
        message: e.message,
        operation: "preview_import",
      });
    sendError(res, req, {
      status: 500,
      code: "INTERNAL_ERROR",
      message: "failed to preview import",
      operation: "preview_import",
      causeCode: prismaCause(e),
      err: e,
    });
  }
});

// Internal signal: the atomic batch claim inside the confirm transaction
// found no confirmable row (lost a race with a concurrent confirm).
class ConfirmConflictError extends Error {}

app.post("/api/imports/:id/confirm", requireAuth, async (req, res) => {
  const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
  if (!params.success) return badRequest(res, req, params.error, "confirm_import");
  const body = confirmImportSchema.safeParse(req.body);
  if (!body.success) return badRequest(res, req, body.error, "confirm_import");
  if (!req.user) return unauthorized(res, req);
  const userId = req.user.id;
  // Scoped lookup: another user's import reads as not found (no leak).
  const batch = await db.importBatch
    .findFirst({ where: { id: params.data.id, userId } })
    .catch(() => null);
  if (!batch)
    return sendError(res, req, {
      status: 404,
      code: "NOT_FOUND_ERROR",
      message: "import not found",
      operation: "confirm_import",
    });
  // Only unprocessed batches can be confirmed. There is no CONFIRMED value
  // in ImportStatus; the terminal state is IMPORTED.
  if (batch.status !== "UPLOADED" && batch.status !== "NEEDS_REVIEW")
    return sendError(res, req, {
      status: 409,
      code: "CONFLICT_ERROR",
      message:
        batch.status === "IMPORTED"
          ? "import already confirmed"
          : "import cannot be confirmed",
      operation: "confirm_import",
    });
  // Same source of truth as preview: deterministic re-parse of the stored
  // PDF. No second parser, no persisted candidate representation.
  const pdf = await readFile(receiptFilePath(basename(batch.filePath))).catch(
    () => null,
  );
  if (!pdf)
    return sendError(res, req, {
      status: 404,
      code: "NOT_FOUND_ERROR",
      message: "stored file missing",
      operation: "confirm_import",
    });
  let candidates: Awaited<ReturnType<typeof toImportCandidates>>;
  try {
    candidates = toImportCandidates(await parseBluPdf(pdf));
  } catch (e) {
    if (e instanceof BluError)
      return sendError(res, req, {
        status: e.status,
        code: "VALIDATION_ERROR",
        message: e.message,
        operation: "confirm_import",
      });
    if (e instanceof PdfExtractError)
      return sendError(res, req, {
        status: 400,
        code: "FILE_ERROR",
        message: e.message,
        operation: "confirm_import",
      });
    return sendError(res, req, {
      status: 500,
      code: "INTERNAL_ERROR",
      message: "failed to confirm import",
      operation: "confirm_import",
      causeCode: prismaCause(e),
      err: e,
    });
  }
  // Identity is the fingerprint: rowIndex restarts per pocket (bluParse)
  // and is not unique across candidates. Every READY candidate needs
  // exactly one assignment; non-READY rows are never writable.
  const ready = candidates.filter((c) => c.disposition === "READY");
  const readyByFingerprint = new Map(ready.map((c) => [c.fingerprint, c]));
  const seen = new Set<string>();
  for (const a of body.data.candidates) {
    if (seen.has(a.fingerprint))
      return sendError(res, req, {
        status: 400,
        code: "VALIDATION_ERROR",
        message: "duplicate candidate assignment",
        operation: "confirm_import",
      });
    seen.add(a.fingerprint);
    if (!readyByFingerprint.has(a.fingerprint)) {
      const known = candidates.some((c) => c.fingerprint === a.fingerprint);
      return sendError(res, req, {
        status: 400,
        code: "VALIDATION_ERROR",
        message: known
          ? "candidate is not importable"
          : "unknown candidate fingerprint",
        operation: "confirm_import",
      });
    }
  }
  if (seen.size !== ready.length)
    return sendError(res, req, {
      status: 400,
      code: "VALIDATION_ERROR",
      message: "all importable candidates require a category",
      operation: "confirm_import",
    });
  // Category ownership, bulk-checked before any write. Same "not found"
  // message as manual transaction creation: no existence leak.
  const categoryIds = [...new Set(body.data.candidates.map((a) => a.categoryId))];
  const owned =
    categoryIds.length === 0
      ? []
      : await db.category
        .findMany({
          where: { id: { in: categoryIds }, userId },
          select: { id: true },
        })
        .catch(() => null);
  if (!owned || owned.length !== categoryIds.length)
    return sendError(res, req, {
      status: 400,
      code: "VALIDATION_ERROR",
      message: "category not found",
      operation: "confirm_import",
    });
  const categoryByFingerprint = new Map(
    body.data.candidates.map((a) => [a.fingerprint, a.categoryId] as const),
  );
  try {
    const updated = await db.$transaction(async (tx) => {
      // Atomic claim: the conditional update holds the row lock, so a
      // concurrent confirm blocks here, then finds no confirmable row
      // after the first commits and gets a 409. Crash before commit
      // rolls the claim back, leaving the batch confirmable for retry.
      const claimed = await tx.importBatch.updateMany({
        where: {
          id: batch.id,
          userId,
          status: { in: ["UPLOADED", "NEEDS_REVIEW"] },
        },
        data: { status: "PROCESSING" },
      });
      if (claimed.count === 0) throw new ConfirmConflictError();
      // Candidate type literals are identical to the Transaction enum;
      // amount is whole IDR; merchant stays null (parser reserves it).
      // The parser reference has no Transaction column and is not stored.
      // Guarded: createMany with zero rows is driver-dependent.
      if (ready.length > 0)
        await tx.transaction.createMany({
          data: ready.map((c) => ({
            type: c.type,
            amount: c.amount,
            date: new Date(`${c.date}T00:00:00Z`),
            note: c.note,
            merchant: c.merchant,
            source: "IMPORT" as const,
            userId,
            categoryId: categoryByFingerprint.get(c.fingerprint) as string,
            importBatchId: batch.id,
            importFingerprint: c.fingerprint,
          })),
        });
      return tx.importBatch.update({
        where: { id: batch.id },
        data: { status: "IMPORTED" },
      });
    });
    res.json({
      batch: toApiImport(updated),
      created: ready.length,
      skipped: candidates.length - ready.length,
    });
  } catch (e) {
    if (e instanceof ConfirmConflictError)
      return sendError(res, req, {
        status: 409,
        code: "CONFLICT_ERROR",
        message: "import already confirmed",
        operation: "confirm_import",
      });
    sendError(res, req, {
      status: 500,
      code: "INTERNAL_ERROR",
      message: "failed to confirm import",
      operation: "confirm_import",
      causeCode: prismaCause(e),
      err: e,
    });
  }
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

// Unknown routes: same { error } contract, WARN not ERROR.
app.use((req, res) => {
  sendError(res, req, {
    status: 404,
    code: "NOT_FOUND_ERROR",
    message: "Route not found",
    operation: "unknown_route",
  });
});

// Centralized boundary: malformed JSON + anything forwarded via next(err).
// Must stay last.
app.use(
  (
    err: unknown,
    req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    if (err instanceof SyntaxError) {
      sendError(res, req, {
        status: 400,
        code: "VALIDATION_ERROR",
        message: "invalid JSON body",
        operation: "parse_body",
      });
      return;
    }
    sendError(res, req, {
      status: 500,
      code: "INTERNAL_ERROR",
      message: "Internal server error",
      operation: "unhandled",
      err,
    });
  },
);

// Vercel entrypoint: default export agar zero-config detection menemukan
// Express app ini (src/index.ts). app.listen di bawah hanya untuk local dev.
export default app;

app.listen(env.PORT, () => {
  logInfo({ message: `api listening on http://localhost:${env.PORT}` });
});

// Last-resort process safety: log structured, then exit (never limp on).
process.on("unhandledRejection", (reason) => {
  logError({
    operation: "unhandled_rejection",
    code: "INTERNAL_ERROR",
    message: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
  process.exit(1);
});

process.on("uncaughtException", (err) => {
  logError({
    operation: "uncaught_exception",
    code: "INTERNAL_ERROR",
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  process.exit(1);
});

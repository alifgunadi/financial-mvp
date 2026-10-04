import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import cors from "cors";
import express from "express";
import multer from "multer";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { env } from "./infra/env.js";
import { db } from "./infra/db.js";
import {
  deleteReceiptFile,
  receiptFilePath,
  saveReceiptFile,
} from "./receiptStore.js";
import { BluError, parseBluPdf } from "./statements/bluParse.js";
import { PdfExtractError } from "./statements/pdfExtract.js";
import {
  summarizeCandidates,
  toImportCandidates,
} from "./statements/bluSemantic.js";
import { logError, logInfo, prismaCause, requestContext, sendError } from "./infra/logger.js";
import { requireAuth } from "./shared/auth.js";
import { badRequest, unauthorized } from "./shared/http.js";
import { ConfirmConflictError } from "./shared/errors.js";
import { categoryMatchesType, toApi } from "./shared/enums.js";
import { toDateString } from "./shared/dates.js";
import type { UploadedFile } from "./shared/upload.js";
import { errorHandler } from "./middleware/error-handler.js";
import { authRoutes } from "./features/auth/routes.js";
import { categoriesRoutes } from "./features/categories/routes.js";
import { transactionsRoutes } from "./features/transactions/routes.js";
import { dashboardRoutes } from "./features/dashboard/routes.js";
import { receiptsRoutes } from "./features/receipts/routes.js";
import { profileRoutes } from "./features/profile/routes.js";
import {
  confirmImportSchema,
  createImportSchema,
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

// Feature routers (auth, categories, transactions, dashboard, receipts, profile).
// Mounted here in the same relative order the inline routes had;
// statement imports stay inline below until their own migration tahap.
app.use("/api/auth", authRoutes);
app.use("/api/categories", categoriesRoutes);
app.use("/api/transactions", transactionsRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/receipts", receiptsRoutes);
app.use("/api/profile", profileRoutes);

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
// The class lives in shared/errors.ts.
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
      message: "all importable candidates must be submitted",
      operation: "confirm_import",
    });
  // Category ownership, bulk-checked before any write. Same "not found"
  // message as manual transaction creation: no existence leak. Null
  // assignments (uncategorized import rows) skip the check entirely.
  const categoryIds = [
    ...new Set(
      body.data.candidates
        .map((a) => a.categoryId)
        .filter((id): id is string => id !== null),
    ),
  ];
  const owned =
    categoryIds.length === 0
      ? []
      : await db.category
        .findMany({
          where: { id: { in: categoryIds }, userId },
          select: { id: true, type: true },
        })
        .catch(() => null);
  if (!owned || owned.length !== categoryIds.length)
    return sendError(res, req, {
      status: 400,
      code: "VALIDATION_ERROR",
      message: "category not found",
      operation: "confirm_import",
    });
  // Type compatibility per candidate: BOTH fits everywhere, otherwise
  // the category type must equal that candidate's type (looked up by
  // fingerprint; exact-set above guarantees every entry is READY).
  // Null assignments skip the check entirely. Client filtering is UX
  // only; this is the final validation.
  const typeByCategoryId = new Map(owned.map((c) => [c.id, c.type] as const));
  for (const a of body.data.candidates) {
    if (a.categoryId === null) continue;
    const candidate = readyByFingerprint.get(a.fingerprint);
    const categoryType = typeByCategoryId.get(a.categoryId);
    if (
      candidate &&
      categoryType &&
      !categoryMatchesType(categoryType, candidate.type)
    )
      return sendError(res, req, {
        status: 400,
        code: "VALIDATION_ERROR",
        message: "category type mismatch",
        operation: "confirm_import",
      });
  }
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
            categoryId: categoryByFingerprint.get(
              c.fingerprint,
            ) as string | null,
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

app.use(errorHandler);

// Vercel entrypoint: default export agar zero-config detection menemukan
// Express app ini (src/index.ts). app.listen di bawah hanya untuk local dev:
// on Vercel the platform invokes the exported app, so binding a port there
// is at best useless and at worst a fatal EADDRINUSE at cold start.
export default app;

if (!process.env.VERCEL) {
  app.listen(env.PORT, () => {
    logInfo({ message: `api listening on http://localhost:${env.PORT}` });
  });
}

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

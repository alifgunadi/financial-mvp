import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { Router } from "express";
import multer from "multer";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "../../infra/db.js";
import { env } from "../../infra/env.js";
import { logInfo, prismaCause, sendError } from "../../infra/logger.js";
import {
  deleteReceiptFile,
  receiptFilePath,
  saveReceiptFile,
} from "../../receiptStore.js";
import { AiError, extractReceipt } from "../../ai.js";
import { requireAuth } from "../../shared/auth.js";
import { ConfirmConflictError, ConfirmValidationError } from "../../shared/errors.js";
import { categoryMatchesType, toApi, toDb } from "../../shared/enums.js";
import { badRequest, unauthorized } from "../../shared/http.js";
import { toApiTransaction } from "../transactions/mappers.js";
import { toApiReceipt } from "./mappers.js";
import { confirmReceiptSchema, updateReceiptSchema } from "./schemas.js";
import {
  claimAndCreateReceiptTransaction,
  validateStoredReviewForConfirm,
} from "./confirm.js";
import type { UploadedFile } from "../../shared/upload.js";

const receiptsRoutes = Router();

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

receiptsRoutes.post("/", requireAuth, (req, res) => {
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

receiptsRoutes.post("/:id/extract", requireAuth, async (req, res) => {
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

// Static single-segment route: must stay BEFORE "/:id" below, otherwise
// "latest" is captured as an :id and rejected as a non-uuid. Returns at
// most one row, owned by the caller.
receiptsRoutes.get("/latest", requireAuth, async (req, res) => {
  if (!req.user) return unauthorized(res, req);
  // No updatedAt on Receipt (adding one is a migration), so "latest"
  // means latest uploaded/extracted; review edits do not reorder.
  const receipt = await db.receipt
    .findFirst({
      where: { userId: req.user.id, status: "NEEDS_REVIEW" },
      orderBy: { createdAt: "desc" },
      include: { suggestedCategory: true },
    })
    .catch(() => null);
  res.json({ receipt: receipt ? toApiReceipt(receipt) : null });
});

receiptsRoutes.delete("/:id", requireAuth, async (req, res) => {
  const parsed = z.object({ id: z.string().uuid() }).safeParse(req.params);
  if (!parsed.success) return badRequest(res, req, parsed.error, "delete_receipt");
  if (!req.user) return unauthorized(res, req);
  const userId = req.user.id;
  // Scoped lookup: another user's receipt reads as not found (no leak).
  const receipt = await db.receipt
    .findFirst({ where: { id: parsed.data.id, userId } })
    .catch(() => null);
  if (!receipt)
    return sendError(res, req, {
      status: 404,
      code: "NOT_FOUND_ERROR",
      message: "receipt not found",
      operation: "delete_receipt",
    });
  // Only unconfirmed reviews are deletable. A CONFIRMED receipt owns a
  // Transaction (created atomically at confirm); it must never be
  // deleted through here, and no cascade may touch that Transaction.
  if (receipt.status !== "NEEDS_REVIEW") {
    const message =
      receipt.status === "CONFIRMED"
        ? "receipt already confirmed"
        : "receipt cannot be deleted";
    return sendError(res, req, {
      status: 409,
      code: "CONFLICT_ERROR",
      message,
      operation: "delete_receipt",
    });
  }
  // Defensive: NEEDS_REVIEW rows never have a Transaction (confirm flips
  // the status atomically), but refuse rather than force-delete.
  const linked = await db.transaction
    .findFirst({ where: { receiptId: receipt.id }, select: { id: true } })
    .catch(() => null);
  if (linked)
    return sendError(res, req, {
      status: 409,
      code: "CONFLICT_ERROR",
      message: "receipt already confirmed",
      operation: "delete_receipt",
    });
  try {
    await db.receipt.delete({ where: { id: receipt.id } });
  } catch (e) {
    // Lost a race with a concurrent delete/confirm: the row is already
    // gone, so report it as not found (second DELETE -> 404).
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025")
      return sendError(res, req, {
        status: 404,
        code: "NOT_FOUND_ERROR",
        message: "receipt not found",
        operation: "delete_receipt",
      });
    return sendError(res, req, {
      status: 500,
      code: "DATABASE_ERROR",
      message: "failed to delete receipt",
      operation: "delete_receipt",
      causeCode: prismaCause(e),
      err: e,
    });
  }
  // Best-effort file cleanup (same pattern as the upload rollback paths):
  // the row is already gone, a leftover file is harmless and retried never.
  await deleteReceiptFile(basename(receipt.filePath));
  logInfo({ req, operation: "delete_receipt", message: `receipt deleted id=${receipt.id}` });
  res.json({ ok: true });
});

receiptsRoutes.get("/:id", requireAuth, async (req, res) => {
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

// Review-only: updates the candidate on a NEEDS_REVIEW receipt.
// Never touches rawAiJson/status/error/extractedAt, never creates a Transaction.
receiptsRoutes.put("/:id", requireAuth, async (req, res) => {
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
        .findFirst({
          where: { id: categoryId, userId },
          select: { id: true, type: true },
        })
        .catch(() => null);
      if (!category)
        return sendError(res, req, {
          status: 400,
          code: "VALIDATION_ERROR",
          message: "category not found",
          operation: "update_receipt",
        });
      // Type compatibility against the effective type (the incoming
      // review value first, the stored extraction otherwise). An unset
      // type cannot be checked, so only a known type is enforced.
      // Client filtering is UX only; this is the final validation.
      const effectiveType =
        type !== undefined
          ? type === null
            ? null
            : toDb(type)
          : receipt.extractedType;
      if (
        effectiveType !== null &&
        !categoryMatchesType(category.type, effectiveType)
      )
        return sendError(res, req, {
          status: 400,
          code: "VALIDATION_ERROR",
          message: "category type mismatch",
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
    // Save-only: creating the Transaction is POST /confirm only.
    return res.json({ receipt: toApiReceipt(updated), transaction: null });
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

// Confirm a reviewed receipt: the full review arrives in the body,
// builds exactly one Transaction from it, and flips the receipt to
// CONFIRMED atomically. Category is required here
// (manual-transaction parity), unlike import. A missing/incomplete body
// is 400: bodyless confirm is no longer supported.
receiptsRoutes.post("/:id/confirm", requireAuth, async (req, res) => {
  const paramParsed = z.object({ id: z.string().uuid() }).safeParse(req.params);
  if (!paramParsed.success)
    return badRequest(res, req, paramParsed.error, "confirm_receipt");
  const parsed = confirmReceiptSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, req, parsed.error, "confirm_receipt");
  if (!req.user) return unauthorized(res, req);
  const userId = req.user.id;
  // Scoped lookup: another user's receipt reads as not found (no leak).
  const receipt = await db.receipt
    .findFirst({ where: { id: paramParsed.data.id, userId } })
    .catch(() => null);
  if (!receipt)
    return sendError(res, req, {
      status: 404,
      code: "NOT_FOUND_ERROR",
      message: "receipt not found",
      operation: "confirm_receipt",
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
      operation: "confirm_receipt",
    });
  }
  // Merchant: explicit null/empty clears; absent keeps the stored review
  // (same collapse rule as PUT cleanMerchant: internal runs collapse).
  const cleanMerchant =
    parsed.data.merchant === undefined
      ? receipt.extractedMerchant
      : typeof parsed.data.merchant === "string"
        ? parsed.data.merchant.replace(/\s+/g, " ") || null
        : null;
  // Ownership and type compatibility are enforced on the payload values
  // by the shared helper (server is the source of truth: client state is
  // never trusted beyond the validated shape above).
  try {
    const vals = await validateStoredReviewForConfirm(
      {
        extractedAmount: BigInt(parsed.data.amount),
        extractedType: toDb(parsed.data.type),
        extractedDate: new Date(`${parsed.data.date}T00:00:00Z`),
        extractedMerchant: cleanMerchant,
        suggestedCategoryId: parsed.data.categoryId,
      },
      userId,
    );
    const result = await claimAndCreateReceiptTransaction(receipt.id, userId, vals);
    logInfo({
      req,
      operation: "confirm_receipt",
      message: `receipt confirmed id=${receipt.id} transaction=${result.created.id}`,
    });
    res.status(201).json({
      receipt: toApiReceipt(result.updated),
      transaction: toApiTransaction(result.created),
    });
  } catch (e) {
    if (e instanceof ConfirmValidationError)
      return sendError(res, req, {
        status: 400,
        code: "VALIDATION_ERROR",
        message: e.message,
        operation: "confirm_receipt",
      });
    if (e instanceof ConfirmConflictError)
      return sendError(res, req, {
        status: 409,
        code: "CONFLICT_ERROR",
        message: "receipt already confirmed",
        operation: "confirm_receipt",
      });
    sendError(res, req, {
      status: 500,
      code: "INTERNAL_ERROR",
      message: "failed to confirm receipt",
      operation: "confirm_receipt",
      causeCode: prismaCause(e),
      err: e,
    });
  }
});

export { receiptsRoutes };

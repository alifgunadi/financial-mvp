import { Router } from "express";
import multer from "multer";
import { db } from "../../infra/db.js";
import { logInfo, prismaCause, sendError } from "../../infra/logger.js";
import {
  hashPassword,
  hashToken,
  requireAuth,
  verifyPassword,
} from "../../shared/auth.js";
import { badRequest, unauthorized } from "../../shared/http.js";
import { sniffImage } from "../../shared/image.js";
import type { UploadedFile } from "../../shared/upload.js";
import { changePasswordSchema, updateProfileSchema } from "./schemas.js";

const profileRoutes = Router();

// Max 512KB: avatar bytes live in the User row (Vercel read-only, no filesystem).
const MAX_AVATAR_BYTES = 512 * 1024;

const AVATAR_TYPES: Record<string, { exts: string[] }> = {
  "image/jpeg": { exts: [".jpg", ".jpeg"] },
  "image/png": { exts: [".png"] },
  "image/webp": { exts: [".webp"] },
};

// Password rate limit: best-effort in-memory per userId. On serverless the
// map lives per instance (cold starts and sibling instances do not share
// it), so this only slows casual guessing; strict enforcement needs a DB table.
const PASSWORD_RATE_MAX = 5;
const PASSWORD_RATE_WINDOW_MS = 15 * 60 * 1000;
const passwordFailures = new Map<string, { failures: number; windowStart: number }>();

type ProfileRow = {
  id: string;
  email: string;
  name: string | null;
  role: unknown;
  avatarMime: string | null;
  avatarUpdatedAt: Date | null;
};

function toApiProfile(row: ProfileRow) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    hasAvatar: row.avatarMime !== null,
    avatarMime: row.avatarMime,
    avatarUpdatedAt: row.avatarUpdatedAt ? row.avatarUpdatedAt.toISOString() : null,
  };
}

const profileSelect = {
  id: true,
  email: true,
  name: true,
  role: true,
  avatarMime: true,
  avatarUpdatedAt: true,
} as const;

function readBearerToken(req: { headers: { authorization?: string } }): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const idx = header.indexOf(" ");
  if (idx === -1) return null;
  if (header.slice(0, idx).toLowerCase() !== "bearer") return null;
  const token = header.slice(idx + 1).trim();
  return token ? token : null;
}

const uploadAvatar = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_AVATAR_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    const known = AVATAR_TYPES[file.mimetype];
    const ext = file.originalname.slice(file.originalname.lastIndexOf(".")).toLowerCase();
    if (!known || !known.exts.includes(ext))
      return cb(new Error("unsupported file type (jpeg, png, or webp only)"));
    cb(null, true);
  },
});

profileRoutes.get("/", requireAuth, async (req, res) => {
  if (!req.user) return unauthorized(res, req);
  const user = await db.user
    .findUnique({ where: { id: req.user.id }, select: profileSelect })
    .catch(() => null);
  if (!user) return unauthorized(res, req);
  res.json(toApiProfile(user));
});

profileRoutes.patch("/", requireAuth, async (req, res) => {
  const parsed = updateProfileSchema.safeParse(req.body ?? {});
  if (!parsed.success) return badRequest(res, req, parsed.error, "update_profile");
  if (!req.user) return unauthorized(res, req);
  const userId = req.user.id;
  try {
    // undefined = no change; null = clear the name. Email/role/unknown keys
    // were stripped by the schema and never reach here.
    const updated =
      parsed.data.name === undefined
        ? await db.user.findUnique({ where: { id: userId }, select: profileSelect })
        : await db.user.update({
            where: { id: userId },
            data: { name: parsed.data.name },
            select: profileSelect,
          });
    if (!updated) return unauthorized(res, req);
    logInfo({ req, operation: "update_profile", message: `profile updated id=${userId}` });
    res.json(toApiProfile(updated));
  } catch (e) {
    sendError(res, req, {
      status: 500,
      code: "DATABASE_ERROR",
      message: "failed to update profile",
      operation: "update_profile",
      causeCode: prismaCause(e),
      err: e,
    });
  }
});

profileRoutes.post("/password", requireAuth, async (req, res) => {
  const parsed = changePasswordSchema.safeParse(req.body ?? {});
  if (!parsed.success) return badRequest(res, req, parsed.error, "change_password");
  if (!req.user) return unauthorized(res, req);
  const userId = req.user.id;
  const now = Date.now();
  const entry = passwordFailures.get(userId);
  if (entry && now - entry.windowStart < PASSWORD_RATE_WINDOW_MS) {
    if (entry.failures >= PASSWORD_RATE_MAX) {
      const retryAfter = Math.max(
        1,
        Math.ceil((entry.windowStart + PASSWORD_RATE_WINDOW_MS - now) / 1000),
      );
      res.setHeader("Retry-After", String(retryAfter));
      return sendError(res, req, {
        status: 429,
        code: "RATE_LIMIT_ERROR",
        message: "too many attempts, try again later",
        operation: "change_password",
      });
    }
  } else if (entry) {
    passwordFailures.delete(userId);
  }
  const user = await db.user
    .findUnique({ where: { id: userId }, select: { id: true, passwordHash: true } })
    .catch(() => null);
  if (!user) return unauthorized(res, req);
  const ok = await verifyPassword(parsed.data.currentPassword, user.passwordHash).catch(
    () => false,
  );
  if (!ok) {
    const prev = passwordFailures.get(userId);
    if (!prev || now - prev.windowStart >= PASSWORD_RATE_WINDOW_MS)
      passwordFailures.set(userId, { failures: 1, windowStart: now });
    else passwordFailures.set(userId, { failures: prev.failures + 1, windowStart: prev.windowStart });
    // 400, never 401: a 401 would trigger the web global logout handler.
    return sendError(res, req, {
      status: 400,
      code: "VALIDATION_ERROR",
      message: "current password is incorrect",
      operation: "change_password",
    });
  }
  const raw = readBearerToken(req);
  if (!raw) return unauthorized(res, req);
  const currentSessionId = hashToken(raw);
  try {
    const newHash = await hashPassword(parsed.data.newPassword);
    await db.$transaction([
      db.user.update({ where: { id: userId }, data: { passwordHash: newHash } }),
      db.session.deleteMany({ where: { userId, id: { not: currentSessionId } } }),
    ]);
    passwordFailures.delete(userId);
    logInfo({ req, operation: "change_password", message: `password changed id=${userId}` });
    res.json({ ok: true });
  } catch (e) {
    sendError(res, req, {
      status: 500,
      code: "DATABASE_ERROR",
      message: "failed to change password",
      operation: "change_password",
      causeCode: prismaCause(e),
      err: e,
    });
  }
});

profileRoutes.post("/avatar", requireAuth, (req, res) => {
  uploadAvatar.single("file")(req, res, async (err: unknown) => {
    if (!req.user) return unauthorized(res, req);
    const userId = req.user.id;
    if (err) {
      if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE")
        return sendError(res, req, {
          status: 413,
          code: "FILE_ERROR",
          message: "file too large (max 512KB)",
          operation: "avatar_upload",
        });
      const message = err instanceof Error ? err.message : "invalid upload";
      return sendError(res, req, {
        status: 400,
        code: "FILE_ERROR",
        message,
        operation: "avatar_upload",
      });
    }
    const file = (req as { file?: UploadedFile }).file;
    if (!file || file.size === 0)
      return sendError(res, req, {
        status: 400,
        code: "FILE_ERROR",
        message: "file is required",
        operation: "avatar_upload",
      });
    const sniffed = sniffImage(file.buffer);
    if (!sniffed || sniffed !== file.mimetype)
      return sendError(res, req, {
        status: 400,
        code: "FILE_ERROR",
        message: "unsupported file type",
        operation: "avatar_upload",
      });
    try {
      const updated = await db.user.update({
        where: { id: userId },
        data: { avatarBytes: file.buffer, avatarMime: sniffed, avatarUpdatedAt: new Date() },
        select: { avatarMime: true, avatarUpdatedAt: true },
      });
      logInfo({ req, operation: "avatar_upload", message: `avatar uploaded id=${userId}` });
      res.json({
        mimeType: updated.avatarMime,
        size: file.size,
        updatedAt: updated.avatarUpdatedAt ? updated.avatarUpdatedAt.toISOString() : null,
      });
    } catch (e) {
      sendError(res, req, {
        status: 500,
        code: "DATABASE_ERROR",
        message: "failed to save avatar",
        operation: "avatar_upload",
        causeCode: prismaCause(e),
        err: e,
      });
    }
  });
});

profileRoutes.get("/avatar", requireAuth, async (req, res) => {
  if (!req.user) return unauthorized(res, req);
  const user = await db.user
    .findUnique({
      where: { id: req.user.id },
      select: { avatarBytes: true, avatarMime: true },
    })
    .catch(() => null);
  if (!user || !user.avatarBytes || !user.avatarMime)
    return sendError(res, req, {
      status: 404,
      code: "NOT_FOUND_ERROR",
      message: "avatar not found",
      operation: "get_avatar",
    });
  const bytes = Buffer.from(user.avatarBytes);
  res.setHeader("Content-Type", user.avatarMime);
  res.setHeader("Content-Length", String(bytes.length));
  res.setHeader("Cache-Control", "private, no-cache");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.send(bytes);
});

profileRoutes.delete("/avatar", requireAuth, async (req, res) => {
  if (!req.user) return unauthorized(res, req);
  const userId = req.user.id;
  try {
    await db.user.update({
      where: { id: userId },
      data: { avatarBytes: null, avatarMime: null, avatarUpdatedAt: null },
    });
    logInfo({ req, operation: "avatar_delete", message: `avatar deleted id=${userId}` });
    res.json({ ok: true });
  } catch (e) {
    sendError(res, req, {
      status: 500,
      code: "DATABASE_ERROR",
      message: "failed to delete avatar",
      operation: "avatar_delete",
      causeCode: prismaCause(e),
      err: e,
    });
  }
});

export { profileRoutes };

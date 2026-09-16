import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import type express from "express";
import { db } from "./db.js";
import { env } from "./env.js";
import { sendError } from "./logger.js";

// Session auth boundary: HttpOnly cookie holds the raw token,
// DB stores only its SHA-256 hash. Nothing secret is ever logged.

export const AUTH_COOKIE = "sid";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Locked business rule: the only account eligible for SUPERADMIN.
// Compared case-insensitively after the existing lowercase normalization.
export const SUPERADMIN_EMAIL = "alifgunadi1303@gmail.com";

export type UserRole = "CLIENT" | "SUPERADMIN";

export interface AuthUser {
  id: string;
  email: string;
  role: UserRole;
}

// Pure role decision (unit-testable). Never reads role from the client.
export function resolveRole(
  normalizedEmail: string,
  superadminExists: boolean,
): UserRole {
  if (normalizedEmail === SUPERADMIN_EMAIL && !superadminExists)
    return "SUPERADMIN";
  return "CLIENT";
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export async function createSession(
  res: express.Response,
  user: AuthUser,
): Promise<void> {
  const raw = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.session.create({
    data: { id: hashToken(raw), userId: user.id, expiresAt },
  });
  const parts = [
    `${AUTH_COOKIE}=${raw}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SESSION_TTL_MS / 1000}`,
  ];
  if (env.COOKIE_SECURE) parts.push("Secure");
  res.appendHeader("Set-Cookie", parts.join("; "));
}

export function clearSessionCookie(res: express.Response): void {
  const parts = [`${AUTH_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (env.COOKIE_SECURE) parts.push("Secure");
  res.appendHeader("Set-Cookie", parts.join("; "));
}

// Idempotent: missing/invalid session still clears the cookie.
export async function revokeSession(
  req: express.Request,
  res: express.Response,
): Promise<void> {
  const raw = readSessionToken(req);
  if (raw)
    await db.session.delete({ where: { id: hashToken(raw) } }).catch(() => {});
  clearSessionCookie(res);
}

function readSessionToken(req: express.Request): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === AUTH_COOKIE)
      return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

export async function requireAuth(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): Promise<void> {
  const raw = readSessionToken(req);
  if (!raw) {
    sendError(res, req, {
      status: 401,
      code: "AUTHENTICATION_ERROR",
      message: "authentication required",
      operation: "authenticate",
    });
    return;
  }
  const session = await db.session
    .findUnique({
      where: { id: hashToken(raw) },
      include: { user: true },
    })
    .catch(() => null);
  if (!session || session.expiresAt.getTime() <= Date.now()) {
    if (session)
      await db.session.delete({ where: { id: session.id } }).catch(() => {});
    sendError(res, req, {
      status: 401,
      code: "AUTHENTICATION_ERROR",
      message: "authentication required",
      operation: "authenticate",
    });
    return;
  }
  req.user = {
    id: session.user.id,
    email: session.user.email,
    role: session.user.role as UserRole,
  };
  next();
}

// Authorization primitive for future use. Not attached to any endpoint yet.
export async function requireSuperAdmin(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): Promise<void> {
  await requireAuth(req, res, () => {
    if (!req.user) return;
    if (req.user.role !== "SUPERADMIN") {
      sendError(res, req, {
        status: 403,
        code: "AUTHORIZATION_ERROR",
        message: "forbidden",
        operation: "authorize_superadmin",
      });
      return;
    }
    next();
  });
}

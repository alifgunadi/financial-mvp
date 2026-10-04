import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import type express from "express";
import { db } from "../infra/db.js";
import { sendError } from "../infra/logger.js";

// Session auth boundary: the raw token is returned to the caller once
// (register/login response) and never stored server-side. The DB keeps
// only its SHA-256 hash. Nothing secret is ever logged.

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export type UserRole = "CLIENT" | "SUPERADMIN";

export interface AuthUser {
  id: string;
  email: string;
  username: string;
  role: UserRole;
}

// Pure role decision (unit-testable). Never reads role from the client.
// superadminEmail comes from env (SUPERADMIN_EMAIL); undefined means
// fail-closed: nobody can become SUPERADMIN.
export function resolveRole(
  normalizedEmail: string,
  superadminEmail: string | undefined,
  superadminExists: boolean,
): UserRole {
  if (
    superadminEmail !== undefined &&
    normalizedEmail === superadminEmail &&
    !superadminExists
  )
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

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export async function createSession(user: AuthUser): Promise<string> {
  const raw = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.session.create({
    data: { id: hashToken(raw), userId: user.id, expiresAt },
  });
  return raw;
}

// Idempotent: missing/invalid token deletes nothing.
export async function revokeSession(req: express.Request): Promise<void> {
  const raw = readBearerToken(req);
  if (raw)
    await db.session.delete({ where: { id: hashToken(raw) } }).catch(() => {});
}

function readBearerToken(req: express.Request): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const idx = header.indexOf(" ");
  if (idx === -1) return null;
  if (header.slice(0, idx).toLowerCase() !== "bearer") return null;
  const token = header.slice(idx + 1).trim();
  return token ? token : null;
}

export async function requireAuth(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): Promise<void> {
  const raw = readBearerToken(req);
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
    username: session.user.username,
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

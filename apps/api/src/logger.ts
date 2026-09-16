import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import type express from "express";

// Centralized error logging: one error = one canonical log line here.
// Routes report via sendError(); nothing else logs errors. stdout/stderr
// only — no external service, no DB table. Never log passwords, hashes,
// cookies, tokens, API keys, headers, bodies, or image content.

export type ErrorCode =
  | "VALIDATION_ERROR"
  | "AUTHENTICATION_ERROR"
  | "AUTHORIZATION_ERROR"
  | "NOT_FOUND_ERROR"
  | "CONFLICT_ERROR"
  | "DATABASE_ERROR"
  | "FILE_ERROR"
  | "AI_ERROR"
  | "NETWORK_ERROR"
  | "INTERNAL_ERROR";

declare global {
  namespace Express {
    interface Request {
      requestId?: string;
    }
  }
}

export function requestContext(
  req: express.Request,
  _res: express.Response,
  next: express.NextFunction,
): void {
  req.requestId = randomUUID().slice(0, 8);
  next();
}

interface LogFields {
  req?: express.Request;
  operation?: string;
  code?: ErrorCode;
  message: string;
  causeCode?: string;
  stack?: string;
  // Pre-sanitized diagnostic detail only (receipt/provider/model/status/
  // type/duration). Never arbitrary objects: the logger must not become
  // a secret leak vector. Appended to the log line, never sent to clients.
  detail?: string;
}

function line(
  level: string,
  { req, operation, code, message, causeCode, stack, detail }: LogFields,
): string {
  const user = (
    req as { user?: { id?: string; role?: string } } | undefined
  )?.user;
  const parts = [
    new Date().toISOString(),
    level,
    `req=${req?.requestId ?? "-"}`,
    ...(user?.id ? [`user=${user.id}`] : []),
    ...(operation ? [`op=${operation}`] : []),
    ...(req?.method && req?.path ? [`${req.method} ${req.path}`] : []),
    ...(code ? [code] : []),
    `"${message}"`,
    ...(causeCode ? [`cause=${causeCode}`] : []),
    ...(detail ? [detail] : []),
  ];
  const first = parts.join(" ");
  return stack ? `${first}\n${stack}` : first;
}

export function logInfo(fields: Omit<LogFields, "code" | "stack" | "causeCode">): void {
  console.log(line("INFO", fields));
}

export function logError(fields: LogFields): void {
  console.error(line("ERROR", fields));
}

// Canonical boundary: logs once (WARN for 4xx, ERROR for 5xx) and sends
// the existing safe { error } contract. `message` is user-facing.
export function sendError(
  res: express.Response,
  req: express.Request,
  opts: {
    status: number;
    code: ErrorCode;
    message: string;
    operation?: string;
    causeCode?: string;
    detail?: string;
    err?: unknown;
  },
): void {
  const { status, code, message, operation, causeCode, detail } = opts;
  const stack =
    status >= 500 && opts.err instanceof Error ? opts.err.stack : undefined;
  const text = line(status >= 500 ? "ERROR" : "WARN", {
    req,
    operation,
    code,
    message: `${status} ${message}`,
    causeCode,
    detail,
    stack,
  });
  if (status >= 500) console.error(text);
  else console.log(text);
  res.status(status).json({ error: message });
}

// Safe Prisma detail for logs only (never sent to the client).
export function prismaCause(e: unknown): string | undefined {
  if (e instanceof Prisma.PrismaClientKnownRequestError) return e.code;
  if (e instanceof Prisma.PrismaClientInitializationError) return "connection_failed";
  return undefined;
}

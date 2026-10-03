import type express from "express";
import { z } from "zod";
import { sendError } from "../infra/logger.js";

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

export { badRequest, unauthorized };

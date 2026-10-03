import express, { type ErrorRequestHandler } from "express";
import { sendError } from "../infra/logger.js";

// Centralized boundary: malformed JSON + anything forwarded via next(err).
// Must stay last.
const errorHandler: ErrorRequestHandler = (
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
};

export { errorHandler };

import { randomUUID } from "node:crypto";
import type { ErrorRequestHandler } from "express";
import { IdentityError } from "../identity/service.js";
import { RuntimeProfileError } from "../runtimeProfile.js";

export const apiErrorHandler: ErrorRequestHandler = (error, request, response, next) => {
  if (response.headersSent) {
    next(error);
    return;
  }
  const requestId = typeof response.locals.requestId === "string"
    ? response.locals.requestId
    : randomUUID();
  response.locals.requestId = requestId;
  response.setHeader("X-Request-ID", requestId);
  if (error instanceof IdentityError) {
    response.status(error.status).json({ error: error.message, code: error.code });
    return;
  }
  if (error instanceof RuntimeProfileError) {
    response.status(403).json({ error: error.message, code: error.code });
    return;
  }
  const bodyError = error as { status?: unknown; type?: unknown };
  if (bodyError.status === 413 || bodyError.type === "entity.too.large") {
    response.status(413).json({ error: "Request body is too large.", code: "payload_too_large" });
    return;
  }
  if (bodyError.status === 400 && bodyError.type === "entity.parse.failed") {
    response.status(400).json({ error: "Request body is not valid JSON.", code: "invalid_json" });
    return;
  }
  console.error("Unhandled API error", {
    method: request.method,
    path: request.path,
    requestId,
    error: error instanceof Error ? error.message : String(error)
  });
  response.status(500).json({ error: "Internal server error.", code: "internal_error" });
};

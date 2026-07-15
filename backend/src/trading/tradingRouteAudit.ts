import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { insertAuditLogForOwner } from "./store.js";
import type { AuthRole } from "./types.js";
import { tradingOwnerFromResponse } from "./ownership.js";

export function auditTradingMutation(req: Request, res: Response, next: NextFunction) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method.toUpperCase())) {
    next();
    return;
  }
  const startedAt = Date.now();
  res.on("finish", () => {
    try {
      const ownerUserId = tradingOwnerFromResponse(res);
      insertAuditLogForOwner(ownerUserId, {
        id: randomUUID(),
        ownerUserId,
        actorUserId: ownerUserId,
        actor: ownerUserId,
        role: (res.locals.authRole as AuthRole | undefined) ?? "read-only",
        action: `${req.method.toUpperCase()} ${req.route?.path ?? req.path}`,
        target: routeParam(req, "id") ?? routeParam(req, "orderId"),
        statusCode: res.statusCode,
        ip: req.ip,
        data: {
          params: sanitizeAuditValue(req.params),
          query: sanitizeAuditValue(req.query),
          body: sanitizeAuditValue(req.body)
        },
        ts: startedAt
      });
    } catch {
      // Audit failures must never break an operator action.
    }
  });
  next();
}

function sanitizeAuditValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeAuditValue);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[key] = /token|secret|apikey|api_key|authorization|password/i.test(key) ? "[redacted]" : sanitizeAuditValue(child);
  }
  return out;
}

function routeParam(req: Request, key: string): string | undefined {
  const value = req.params[key];
  return Array.isArray(value) ? value[0] : value;
}

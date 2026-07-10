import type { NextFunction, Request, Response } from "express";

const csp = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self' https: ws: wss:",
  "worker-src 'self' blob:",
  "form-action 'self'"
].join("; ");

export function securityHeaders(req: Request, res: Response, next: NextFunction) {
  res.setHeader("Content-Security-Policy", csp);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  if (isTrustworthyOrigin(req)) res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  next();
}

function isTrustworthyOrigin(req: Request): boolean {
  const forwardedProto = req.headers["x-forwarded-proto"];
  if (req.secure || forwardedProto === "https") return true;
  const host = (req.headers.host ?? "").split(":")[0];
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

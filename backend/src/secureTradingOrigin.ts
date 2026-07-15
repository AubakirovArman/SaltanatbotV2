import type { Application, NextFunction, Request, Response } from "express";

const enabledValues = new Set(["1", "true", "yes", "on"]);

/**
 * Configure Express' proxy trust only when the operator explicitly opted in.
 * Without this setting Express intentionally ignores X-Forwarded-Proto when it
 * computes req.secure.
 */
export function configureTrustedProxy(app: Application): void {
  const raw = process.env.TRUST_PROXY?.trim();
  if (!raw) return;
  if (raw === "true") {
    app.set("trust proxy", true);
    return;
  }
  if (/^\d+$/.test(raw)) {
    app.set("trust proxy", Number(raw));
    return;
  }
  const entries = raw.split(",").map((entry) => entry.trim()).filter(Boolean);
  app.set("trust proxy", entries.length === 1 ? entries[0] : entries);
}

/**
 * Dangerous trading mutations are allowed only over TLS (direct or through an
 * explicitly trusted proxy), over a direct loopback socket, or through the
 * deliberately loud development escape hatch.
 */
export function isSecureTradingOrigin(req: Request): boolean {
  if (enabledValues.has(process.env.ALLOW_INSECURE_TRADING_MUTATIONS?.trim().toLowerCase() ?? "")) return true;
  if (req.secure || (req.socket as Request["socket"] & { encrypted?: boolean }).encrypted === true) return true;

  // A proxy marker changes the trust boundary. Do not treat the proxy's local
  // socket as the end user's loopback connection. req.secure becomes true only
  // when Express trusts that proxy through configureTrustedProxy().
  if (hasForwardingHeaders(req)) return false;
  return isLoopbackAddress(req.socket.remoteAddress);
}

export function requireSecureTradingOrigin(req: Request, res: Response, next: NextFunction): void {
  if (isSecureTradingOrigin(req)) {
    next();
    return;
  }
  res.status(426).json({
    error: "This live-trading operation requires HTTPS or a direct localhost connection.",
    code: "SECURE_TRADING_ORIGIN_REQUIRED"
  });
}

export function ensureSecureTradingOrigin(req: Request, res: Response): boolean {
  if (isSecureTradingOrigin(req)) return true;
  requireSecureTradingOrigin(req, res, () => undefined);
  return false;
}

function hasForwardingHeaders(req: Request): boolean {
  return req.headers["x-forwarded-proto"] !== undefined
    || req.headers["x-forwarded-for"] !== undefined
    || req.headers.forwarded !== undefined;
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase().split("%")[0];
  return normalized === "::1"
    || normalized === "0:0:0:0:0:0:0:1"
    || normalized.startsWith("127.")
    || normalized.startsWith("::ffff:127.");
}

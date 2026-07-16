import { normalizeExactHttpOrigin } from "./exactOrigin.js";

export interface WebSocketOriginPolicy {
  readonly publicOrigin?: string;
  readonly allowedOrigins: readonly string[];
}

/**
 * Browser WebSockets must present an exact configured HTTP(S) origin. Public
 * paper installs may omit PUBLIC_ORIGIN, so they retain same-host access using
 * a strictly parsed Host header. Non-browser clients may omit Origin entirely;
 * the target WebSocket still performs its normal session/ticket authentication.
 */
export function websocketOriginAllowed(origin: string | undefined, host: string | undefined, policy: WebSocketOriginPolicy): boolean {
  if (origin === undefined) return true;
  const normalizedOrigin = normalizeExactHttpOrigin(origin);
  if (!normalizedOrigin) return false;
  if (normalizedOrigin === policy.publicOrigin || policy.allowedOrigins.includes(normalizedOrigin)) return true;

  // private-live always has PUBLIC_ORIGIN, so dynamic Host equality is only a
  // compatibility fallback for same-origin public paper/self-hosted browsers.
  if (policy.publicOrigin !== undefined) return false;
  const normalizedHost = normalizeHostHeader(host);
  return normalizedHost !== undefined && new URL(normalizedOrigin).host === normalizedHost;
}

function normalizeHostHeader(host: string | undefined): string | undefined {
  if (!host || host.length > 512) return undefined;
  const origin = normalizeExactHttpOrigin(`http://${host}`);
  return origin ? new URL(origin).host : undefined;
}

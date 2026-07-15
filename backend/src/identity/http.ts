import type { Request, Response } from "express";
import type { IdentityPrincipal, SessionCredentials } from "./types.js";
import type { IdentityService, RequestMetadata } from "./service.js";

export const sessionCookieName = "sbv2_session";
export const csrfCookieName = "sbv2_csrf";

export async function principalFromRequest(service: IdentityService, request: Request): Promise<IdentityPrincipal | undefined> {
  return service.authenticate(readCookie(request.headers.cookie, sessionCookieName));
}

export function csrfFromRequest(request: Request): string | undefined {
  const value = request.headers["x-csrf-token"];
  return typeof value === "string" ? value : undefined;
}

export function csrfFromCookie(request: Request): string | undefined {
  return readCookie(request.headers.cookie, csrfCookieName);
}

export function requestNeedsCsrf(request: Request): boolean {
  return !["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase());
}

export function requestMetadata(request: Request): RequestMetadata {
  const userAgent = request.headers["user-agent"];
  return {
    ipAddress: request.ip || request.socket.remoteAddress,
    userAgent: typeof userAgent === "string" ? userAgent.slice(0, 512) : undefined
  };
}

export function setAuthCookies(response: Response, credentials: SessionCredentials): void {
  const maxAge = Math.max(1, Math.floor((credentials.expiresAt.getTime() - Date.now()) / 1000));
  response.append("Set-Cookie", formatCookie(sessionCookieName, credentials.sessionToken, maxAge, true));
  response.append("Set-Cookie", formatCookie(csrfCookieName, credentials.csrfToken, maxAge, false));
}

export function clearAuthCookies(response: Response): void {
  response.append("Set-Cookie", formatCookie(sessionCookieName, "", 0, true));
  response.append("Set-Cookie", formatCookie(csrfCookieName, "", 0, false));
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1 || part.slice(0, index).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function formatCookie(name: string, value: string, maxAge: number, httpOnly: boolean): string {
  const attributes = [
    `${name}=${encodeURIComponent(value)}`,
    "SameSite=Strict",
    "Path=/",
    `Max-Age=${maxAge}`
  ];
  if (httpOnly) attributes.push("HttpOnly");
  if (process.env.COOKIE_SECURE === "1" || process.env.COOKIE_SECURE === "true") attributes.push("Secure");
  return attributes.join("; ");
}

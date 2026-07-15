import type { NextFunction, Request, Response } from "express";
import { afterEach, describe, expect, it } from "vitest";
import { configureIdentityAuth, requireAppAuth, verifyAppWsSession } from "../src/auth.js";
import { MemoryIdentityRepository } from "../src/identity/memoryRepository.js";
import { IdentityService } from "../src/identity/service.js";

afterEach(() => configureIdentityAuth(undefined));

describe("database authentication middleware", () => {
  it("allows only password-change routes until the bootstrap password is replaced", async () => {
    const service = new IdentityService(new MemoryIdentityRepository());
    await service.bootstrapAdmin("operator", "temporary-Admin-password-2026");
    configureIdentityAuth(service);
    const initial = await service.login("operator", "temporary-Admin-password-2026");
    const initialCookie = `sbv2_session=${encodeURIComponent(initial.sessionToken)}`;

    expect(await verifyAppWsSession(initialCookie)).toBe(false);
    expect(await authorize(service, initialCookie, "GET")).toMatchObject({
      status: 403,
      body: { code: "password_change_required" }
    });

    const principal = (await service.authenticate(initial.sessionToken))!;
    await service.changePassword(
      principal,
      "temporary-Admin-password-2026",
      "permanent-Admin-password-2026"
    );
    const active = await service.login("operator", "permanent-Admin-password-2026");
    const activeCookie = `sbv2_session=${encodeURIComponent(active.sessionToken)}`;

    expect(await verifyAppWsSession(activeCookie)).toBe(true);
    expect(await authorize(service, activeCookie, "GET")).toMatchObject({ status: 200 });
    expect(await authorize(service, activeCookie, "POST")).toMatchObject({
      status: 403,
      body: { code: "invalid_csrf" }
    });
    expect(await authorize(service, activeCookie, "POST", active.csrfToken)).toMatchObject({ status: 200 });
  });
});

function authorize(
  service: IdentityService,
  cookie: string,
  method: string,
  csrfToken?: string
): Promise<{ status: number; body?: unknown }> {
  configureIdentityAuth(service);
  return new Promise((resolve, reject) => {
    let status = 200;
    const request = {
      method,
      headers: { cookie, ...(csrfToken ? { "x-csrf-token": csrfToken } : {}) }
    } as Request;
    const response = {
      locals: {},
      status(code: number) {
        status = code;
        return this;
      },
      json(body: unknown) {
        resolve({ status, body });
        return this;
      }
    } as unknown as Response;
    const next: NextFunction = (error?: unknown) => error ? reject(error) : resolve({ status });
    requireAppAuth(request, response, next);
  });
}

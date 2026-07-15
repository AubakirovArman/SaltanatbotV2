import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PasswordHashCapacityError, PasswordHashGate } from "../src/identity/password.js";
import { BoundedAuthRateLimitStore, type AuthRateLimitPolicy } from "../src/identity/rateLimit.js";
import { createIdentityRouters, type IdentityRouteProtectionOptions } from "../src/identity/routes.js";
import { IdentityError, type IdentityService } from "../src/identity/service.js";
import type { PublicIdentityUser, SessionCredentials } from "../src/identity/types.js";

const servers: Server[] = [];
const permissivePolicy: AuthRateLimitPolicy = { windowMs: 60_000, maxAttempts: 100, blockMs: 60_000 };

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("identity route abuse protection", () => {
  it("blocks one IP that rotates through unknown login names", async () => {
    const login = vi.fn(async () => {
      throw new IdentityError(401, "invalid_credentials", "Invalid login or password.");
    });
    const service = fakeService({ login });
    const baseUrl = await startAuthServer(service, {
      loginIpPolicy: { windowMs: 60_000, maxAttempts: 2, blockMs: 60_000 },
      loginIdentityPolicy: permissivePolicy
    });

    const first = await post(baseUrl, "/login", { login: "unknown-a", password: "wrong-password" });
    const second = await post(baseUrl, "/login", { login: "unknown-b", password: "wrong-password" });
    const blocked = await post(baseUrl, "/login", { login: "unknown-c", password: "wrong-password" });

    expect(first).toMatchObject({ status: 401, body: { code: "invalid_credentials" } });
    expect(second).toMatchObject({ status: 401, body: { code: "invalid_credentials" } });
    expect(blocked).toMatchObject({ status: 429, body: { code: "rate_limited" } });
    expect(blocked.headers.get("retry-after")).toBe("60");
    expect(login).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      bucket: "IP",
      loginIpPolicy: { windowMs: 60_000, maxAttempts: 2, blockMs: 60_000 },
      loginIdentityPolicy: permissivePolicy,
      logins: ["parallel-a", "parallel-b", "parallel-c"]
    },
    {
      bucket: "identity",
      loginIpPolicy: permissivePolicy,
      loginIdentityPolicy: { windowMs: 60_000, maxAttempts: 2, blockMs: 60_000 },
      logins: ["parallel-user", "parallel-user", "parallel-user"]
    }
  ])("reserves concurrent $bucket allowances before password verification starts", async ({ loginIpPolicy, loginIdentityPolicy, logins }) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const login = vi.fn(async () => {
      // Keep the first two password checks in flight. If allowances were only
      // counted after rejection, a third request would reach this function.
      if (login.mock.calls.length <= 2) await gate;
      throw new IdentityError(401, "invalid_credentials", "Invalid login or password.");
    });
    const baseUrl = await startAuthServer(fakeService({ login }), { loginIpPolicy, loginIdentityPolicy });

    const firstPromise = post(baseUrl, "/login", { login: logins[0], password: "wrong-password" });
    const secondPromise = post(baseUrl, "/login", { login: logins[1], password: "wrong-password" });
    await vi.waitFor(() => expect(login).toHaveBeenCalledTimes(2));
    const blocked = await post(baseUrl, "/login", { login: logins[2], password: "wrong-password" });
    release();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(first.status).toBe(401);
    expect(second.status).toBe(401);
    expect(blocked).toMatchObject({ status: 429, body: { code: "rate_limited" } });
    expect(login).toHaveBeenCalledTimes(2);
  });

  it("refunds capacity errors without poisoning the selected IP or identity", async () => {
    const login = vi.fn(async () => {
      throw new PasswordHashCapacityError();
    });
    const store = new BoundedAuthRateLimitStore(16);
    const baseUrl = await startAuthServer(fakeService({ login }), {
      store,
      loginIpPolicy: { windowMs: 60_000, maxAttempts: 1, blockMs: 60_000 },
      loginIdentityPolicy: { windowMs: 60_000, maxAttempts: 1, blockMs: 60_000 }
    });

    const first = await post(baseUrl, "/login", { login: "busy-user", password: "password" });
    const second = await post(baseUrl, "/login", { login: "busy-user", password: "password" });

    expect(first).toMatchObject({ status: 503, body: { code: "auth_busy" } });
    expect(second).toMatchObject({ status: 503, body: { code: "auth_busy" } });
    expect(login).toHaveBeenCalledTimes(2);
    expect(store.size).toBe(0);
  });

  it("refunds internal failures, keeps their response generic and counts the next credential failure", async () => {
    const login = vi
      .fn()
      .mockRejectedValueOnce(new Error("database host and credentials must not leak"))
      .mockRejectedValueOnce(new IdentityError(401, "invalid_credentials", "Invalid login or password."));
    const baseUrl = await startAuthServer(fakeService({ login }), {
      loginIpPolicy: permissivePolicy,
      loginIdentityPolicy: { windowMs: 60_000, maxAttempts: 1, blockMs: 60_000 }
    });

    const internal = await post(baseUrl, "/login", { login: "chosen-user", password: "password" });
    const rejected = await post(baseUrl, "/login", { login: "chosen-user", password: "wrong-password" });
    const blocked = await post(baseUrl, "/login", { login: "chosen-user", password: "wrong-password" });

    expect(internal).toEqual(expect.objectContaining({ status: 500, body: { error: "Internal server error.", code: "internal_error" } }));
    expect(JSON.stringify(internal.body)).not.toContain("database host");
    expect(rejected).toMatchObject({ status: 401, body: { code: "invalid_credentials" } });
    expect(blocked).toMatchObject({ status: 429, body: { code: "rate_limited" } });
    expect(login).toHaveBeenCalledTimes(2);
  });

  it("refunds only the successful IP reservation while preserving earlier IP failures", async () => {
    const login = vi.fn(async (loginName: string) => {
      if (loginName === "valid-user") return sessionCredentials(loginName);
      throw new IdentityError(401, "invalid_credentials", "Invalid login or password.");
    });
    const baseUrl = await startAuthServer(fakeService({ login }), {
      loginIpPolicy: { windowMs: 60_000, maxAttempts: 2, blockMs: 60_000 },
      loginIdentityPolicy: permissivePolicy
    });

    const firstFailure = await post(baseUrl, "/login", { login: "unknown-a", password: "wrong-password" });
    const success = await post(baseUrl, "/login", { login: "valid-user", password: "correct-password" });
    const secondFailure = await post(baseUrl, "/login", { login: "unknown-b", password: "wrong-password" });
    const blocked = await post(baseUrl, "/login", { login: "unknown-c", password: "wrong-password" });

    expect(firstFailure.status).toBe(401);
    expect(success.status).toBe(200);
    expect(secondFailure.status).toBe(401);
    expect(blocked).toMatchObject({ status: 429, body: { code: "rate_limited" } });
    expect(login).toHaveBeenCalledTimes(3);
  });

  it("counts successful registrations instead of resetting the IP bucket", async () => {
    const register = vi.fn(async (login: string) => publicUser(login));
    const service = fakeService({ register });
    const baseUrl = await startAuthServer(service, {
      registrationIpPolicy: { windowMs: 60_000, maxAttempts: 2, blockMs: 60_000 }
    });

    const first = await post(baseUrl, "/register", { login: "new-user-a", password: "valid-password-2026" });
    const second = await post(baseUrl, "/register", { login: "new-user-b", password: "valid-password-2026" });
    const blocked = await post(baseUrl, "/register", { login: "new-user-c", password: "valid-password-2026" });

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(blocked).toMatchObject({ status: 429, body: { code: "rate_limited" } });
    expect(register).toHaveBeenCalledTimes(2);
  });

  it("keeps the shared authentication store bounded and fails closed for unseen keys", async () => {
    const login = vi.fn(async () => {
      throw new IdentityError(401, "invalid_credentials", "Invalid login or password.");
    });
    const store = new BoundedAuthRateLimitStore(3);
    const baseUrl = await startAuthServer(fakeService({ login }), {
      store,
      loginIpPolicy: permissivePolicy,
      loginIdentityPolicy: permissivePolicy
    });

    await post(baseUrl, "/login", { login: "identity-a", password: "wrong-password" });
    await post(baseUrl, "/login", { login: "identity-b", password: "wrong-password" });
    const blocked = await post(baseUrl, "/login", { login: "identity-c", password: "wrong-password" });

    expect(store.size).toBe(3); // one IP bucket plus two identity buckets
    expect(blocked).toMatchObject({ status: 429, body: { code: "rate_limited" } });
    expect(login).toHaveBeenCalledTimes(2);
  });
});

describe("password hash capacity gate", () => {
  it("runs only the configured concurrency, bounds the queue and rejects overflow", async () => {
    const gate = new PasswordHashGate(2, 1);
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const first = gate.run(
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve;
        })
    );
    const second = gate.run(
      () =>
        new Promise<void>((resolve) => {
          releaseSecond = resolve;
        })
    );
    await vi.waitFor(() => {
      expect(releaseFirst).toBeTypeOf("function");
      expect(releaseSecond).toBeTypeOf("function");
    });

    const queued = gate.run(async () => "queued-complete");
    await expect(gate.run(async () => "overflow")).rejects.toBeInstanceOf(PasswordHashCapacityError);

    releaseFirst();
    await expect(queued).resolves.toBe("queued-complete");
    releaseSecond();
    await Promise.all([first, second]);
  });
});

async function startAuthServer(service: IdentityService, protection: IdentityRouteProtectionOptions): Promise<string> {
  const app = express();
  const routers = createIdentityRouters(service, {
    store: protection.store ?? new BoundedAuthRateLimitStore(128),
    loginIpPolicy: protection.loginIpPolicy ?? permissivePolicy,
    loginIdentityPolicy: protection.loginIdentityPolicy ?? permissivePolicy,
    registrationIpPolicy: protection.registrationIpPolicy ?? permissivePolicy,
    now: protection.now
  });
  app.use("/api/auth", routers.auth);
  app.use((_error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    response.status(500).json({ error: "Internal server error.", code: "internal_error" });
  });
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}/api/auth`;
}

async function post(
  baseUrl: string,
  path: string,
  body: unknown
): Promise<{
  status: number;
  body: Record<string, unknown>;
  headers: Headers;
}> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
    headers: response.headers
  };
}

function fakeService(overrides: Partial<IdentityService>): IdentityService {
  return {
    allowRegistration: true,
    allowNonAdminTrading: true,
    ...overrides
  } as unknown as IdentityService;
}

function publicUser(login: string): PublicIdentityUser {
  const now = new Date(0).toISOString();
  return {
    id: `id-${login}`,
    login,
    status: "pending",
    appRole: "user",
    tradingRole: "none",
    mustChangePassword: false,
    createdAt: now,
    updatedAt: now
  };
}

function sessionCredentials(login: string): SessionCredentials {
  return {
    sessionToken: "session-token",
    csrfToken: "csrf-token",
    expiresAt: new Date(Date.now() + 60_000),
    user: { ...publicUser(login), status: "active" }
  };
}

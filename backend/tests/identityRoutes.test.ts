import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { csrfCookieName, sessionCookieName } from "../src/identity/http.js";
import { MemoryIdentityRepository } from "../src/identity/memoryRepository.js";
import { createIdentityRouters } from "../src/identity/routes.js";
import { IdentityService } from "../src/identity/service.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve()))
      )
  );
});

describe("identity administration routes", () => {
  it("uses opaque session IDs, rejects invalid user UUIDs and disables caching", async () => {
    const context = await startIdentityServer();

    const users = await fetch(`${context.baseUrl}/api/admin/users`, {
      headers: context.headers()
    });
    expect(users.status).toBe(200);
    expect(users.headers.get("cache-control")).toBe("no-store");
    expect(users.headers.get("x-request-id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f-]{27}$/i
    );

    const sessions = await fetch(`${context.baseUrl}/api/auth/sessions`, {
      headers: context.headers()
    });
    expect(sessions.status).toBe(200);
    expect(sessions.headers.get("cache-control")).toBe("no-store");
    const sessionBody = (await sessions.json()) as {
      sessions: Array<{ publicId: string; current: boolean }>;
      total: number;
      revocableSessionCount: number;
    };
    expect(sessionBody.sessions).toHaveLength(1);
    expect(sessionBody).toMatchObject({
      total: 1,
      revocableSessionCount: 1
    });
    expect(sessionBody.sessions[0]).toMatchObject({ current: true });
    expect(sessionBody.sessions[0]?.publicId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f-]{27}$/i
    );
    expect(JSON.stringify(sessionBody)).not.toContain(
      context.credentials.sessionToken
    );

    const adminSessions = await fetch(
      `${context.baseUrl}/api/admin/users/${context.adminId.toUpperCase()}/sessions`,
      { headers: context.headers() }
    );
    expect(adminSessions.status).toBe(200);
    expect(await adminSessions.json()).toMatchObject({
      sessions: [{ current: true }],
      total: 1,
      revocableSessionCount: 1
    });

    const invalidRoute = await fetch(
      `${context.baseUrl}/api/admin/users/not-a-uuid/disable`,
      {
        method: "POST",
        headers: context.headers(true),
        body: JSON.stringify({
          reason: "invalid UUID regression",
          expectedAuthorizationRevision: 1
        })
      }
    );
    expect(invalidRoute.status).toBe(400);
    expect(await invalidRoute.json()).toMatchObject({
      code: "invalid_user_id"
    });
    expect(invalidRoute.headers.get("cache-control")).toBe("no-store");

    const invalidAudit = await fetch(
      `${context.baseUrl}/api/admin/audit?subjectUserId=not-a-uuid`,
      { headers: context.headers() }
    );
    expect(invalidAudit.status).toBe(400);
    expect(await invalidAudit.json()).toMatchObject({
      code: "invalid_user_id"
    });
    expect(invalidAudit.headers.get("cache-control")).toBe("no-store");
  });

  it("requires reason/revision, returns mutation counts and blocks live grants", async () => {
    const context = await startIdentityServer();
    const pending = await context.service.register(
      "route-client",
      "correct-horse-battery-staple"
    );

    const missingReason = await fetch(
      `${context.baseUrl}/api/admin/users/${pending.id}/activate`,
      {
        method: "POST",
        headers: context.headers(true),
        body: JSON.stringify({
          expectedAuthorizationRevision: pending.authorizationRevision
        })
      }
    );
    expect(missingReason.status).toBe(400);
    expect(await missingReason.json()).toMatchObject({
      code: "invalid_request"
    });

    const activated = await fetch(
      `${context.baseUrl}/api/admin/users/${pending.id}/activate`,
      {
        method: "POST",
        headers: context.headers(true),
        body: JSON.stringify({
          reason: "approve first test client",
          expectedAuthorizationRevision: pending.authorizationRevision
        })
      }
    );
    expect(activated.status).toBe(200);
    const activatedBody = (await activated.json()) as {
      user: { authorizationRevision: number };
      revokedSessionCount: number;
      revokedCurrentSession: boolean;
      cancelledJobCount: number;
    };
    expect(activatedBody).toMatchObject({
      revokedSessionCount: 0,
      revokedCurrentSession: false,
      cancelledJobCount: 0
    });
    expect(activatedBody.user.authorizationRevision).toBe(
      pending.authorizationRevision + 1
    );

    const paperGrant = await fetch(
      `${context.baseUrl}/api/admin/users/${pending.id}/permissions`,
      {
        method: "PATCH",
        headers: context.headers(true),
        body: JSON.stringify({
          reason: "grant isolated paper access",
          expectedAuthorizationRevision:
            activatedBody.user.authorizationRevision,
          tradingRole: "paper-trade"
        })
      }
    );
    expect(paperGrant.status).toBe(200);
    const paperBody = (await paperGrant.json()) as {
      user: { authorizationRevision: number };
    };

    const filtered = await fetch(
      `${context.baseUrl}/api/admin/users?status=active&appRole=user&tradingRole=paper-trade&query=route-client&page=1&pageSize=1`,
      { headers: context.headers() }
    );
    expect(filtered.status).toBe(200);
    expect(await filtered.json()).toMatchObject({
      users: [{ id: pending.id, tradingRole: "paper-trade" }],
      page: 1,
      pageSize: 1,
      total: 1,
      totalPages: 1
    });

    const liveGrant = await fetch(
      `${context.baseUrl}/api/admin/users/${pending.id}/permissions`,
      {
        method: "PATCH",
        headers: context.headers(true),
        body: JSON.stringify({
          reason: "must remain blocked before HTTPS",
          expectedAuthorizationRevision:
            paperBody.user.authorizationRevision,
          tradingRole: "live-trade"
        })
      }
    );
    expect(liveGrant.status).toBe(409);
    expect(await liveGrant.json()).toMatchObject({
      code: "live_trading_role_forbidden"
    });

    const audit = await fetch(
      `${context.baseUrl}/api/admin/audit?subjectUserId=${pending.id}`,
      { headers: context.headers() }
    );
    expect(audit.status).toBe(200);
    const auditBody = (await audit.json()) as {
      events: Array<{
        eventType: string;
        reason?: string;
        before?: { authorizationRevision?: number };
        after?: { authorizationRevision?: number };
      }>;
    };
    const activationAudit = auditBody.events.find(
      (event) => event.eventType === "user.activated"
    );
    expect(activationAudit).toMatchObject({
      eventType: "user.activated",
      reason: "approve first test client",
      before: { authorizationRevision: pending.authorizationRevision },
      after: {
        authorizationRevision: pending.authorizationRevision + 1
      }
    });
  });

  it("lists and revokes own sessions by public ID without exposing secret hashes", async () => {
    const context = await startIdentityServer();
    const second = await context.service.login(
      "route-admin",
      "temporary-Admin-password-2026",
      { userAgent: "second-browser" }
    );

    const revokeOthers = await fetch(
      `${context.baseUrl}/api/auth/sessions/revoke-others`,
      {
        method: "POST",
        headers: context.headers(true),
        body: JSON.stringify({ reason: "close every other browser session" })
      }
    );
    expect(revokeOthers.status).toBe(200);
    expect(await revokeOthers.json()).toMatchObject({
      revokedSessionCount: 1,
      revokedCurrentSession: false
    });
    expect(await context.service.authenticate(second.sessionToken)).toBeUndefined();

    const third = await context.service.login(
      "route-admin",
      "temporary-Admin-password-2026",
      { userAgent: "third-browser" }
    );
    const sessions = await fetch(`${context.baseUrl}/api/auth/sessions`, {
      headers: context.headers()
    });
    const body = (await sessions.json()) as {
      sessions: Array<{
        publicId: string;
        current: boolean;
        revokedAt?: string;
        userAgent?: string;
      }>;
      total: number;
      revocableSessionCount: number;
    };
    expect(body).toMatchObject({
      total: 3,
      revocableSessionCount: 2
    });
    const thirdSession = body.sessions.find(
      (session) =>
        session.userAgent === "third-browser" && session.revokedAt === undefined
    );
    expect(thirdSession?.current).toBe(false);
    expect(JSON.stringify(body)).not.toContain(third.sessionToken);

    const revokeOne = await fetch(
      `${context.baseUrl}/api/auth/sessions/${thirdSession?.publicId}/revoke`,
      {
        method: "POST",
        headers: context.headers(true),
        body: JSON.stringify({ reason: "close selected browser session" })
      }
    );
    expect(revokeOne.status).toBe(200);
    expect(await revokeOne.json()).toMatchObject({
      revokedSessionCount: 1,
      revokedCurrentSession: false
    });
    expect(await context.service.authenticate(third.sessionToken)).toBeUndefined();

    const afterRevokeOne = await fetch(
      `${context.baseUrl}/api/auth/sessions`,
      { headers: context.headers() }
    );
    expect(await afterRevokeOne.json()).toMatchObject({
      total: 3,
      revocableSessionCount: 1
    });

    const revokeAll = await fetch(
      `${context.baseUrl}/api/auth/sessions/revoke-all`,
      {
        method: "POST",
        headers: context.headers(true),
        body: JSON.stringify({ reason: "sign out on every browser" })
      }
    );
    expect(revokeAll.status).toBe(200);
    expect(await revokeAll.json()).toMatchObject({
      revokedSessionCount: 1,
      revokedCurrentSession: true
    });
    expect(revokeAll.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("clears auth cookies when an admin revokes their current session", async () => {
    const revokeOneContext = await startIdentityServer();
    const ownSessions = await fetch(
      `${revokeOneContext.baseUrl}/api/admin/users/${revokeOneContext.adminId}/sessions`,
      { headers: revokeOneContext.headers() }
    );
    const ownBody = (await ownSessions.json()) as {
      sessions: Array<{ publicId: string; current: boolean }>;
    };
    const current = ownBody.sessions.find((session) => session.current);
    const revokeOne = await fetch(
      `${revokeOneContext.baseUrl}/api/admin/users/${revokeOneContext.adminId}/sessions/${current?.publicId}/revoke`,
      {
        method: "POST",
        headers: revokeOneContext.headers(true),
        body: JSON.stringify({ reason: "admin self revoke regression" })
      }
    );
    expect(revokeOne.status).toBe(200);
    expect(await revokeOne.json()).toMatchObject({
      revokedSessionCount: 1,
      revokedCurrentSession: true
    });
    expect(revokeOne.headers.get("set-cookie")).toContain("Max-Age=0");

    const revokeAllContext = await startIdentityServer();
    await revokeAllContext.service.login(
      "route-admin",
      "temporary-Admin-password-2026",
      { userAgent: "admin-second-session" }
    );
    const revokeAll = await fetch(
      `${revokeAllContext.baseUrl}/api/admin/users/${revokeAllContext.adminId}/sessions/revoke-all`,
      {
        method: "POST",
        headers: revokeAllContext.headers(true),
        body: JSON.stringify({ reason: "admin self revoke all regression" })
      }
    );
    expect(revokeAll.status).toBe(200);
    expect(await revokeAll.json()).toMatchObject({
      revokedSessionCount: 2,
      revokedCurrentSession: true
    });
    expect(revokeAll.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("canonicalizes uppercase self IDs and logs out after useful self-permission changes", async () => {
    const context = await startIdentityServer();
    const second = await context.service.register(
      "route-second-admin",
      "correct-horse-battery-staple"
    );
    const activate = await fetch(
      `${context.baseUrl}/api/admin/users/${second.id}/activate`,
      {
        method: "POST",
        headers: context.headers(true),
        body: JSON.stringify({
          reason: "prepare second administrator",
          expectedAuthorizationRevision: second.authorizationRevision
        })
      }
    );
    const activated = (await activate.json()) as {
      user: { authorizationRevision: number };
    };
    const promote = await fetch(
      `${context.baseUrl}/api/admin/users/${second.id}/permissions`,
      {
        method: "PATCH",
        headers: context.headers(true),
        body: JSON.stringify({
          reason: "promote second administrator",
          expectedAuthorizationRevision: activated.user.authorizationRevision,
          appRole: "admin"
        })
      }
    );
    expect(promote.status).toBe(200);

    const current = await context.service.repository.findUserById(
      context.adminId
    );
    const uppercaseId = context.adminId.toUpperCase();
    const disable = await fetch(
      `${context.baseUrl}/api/admin/users/${uppercaseId}/disable`,
      {
        method: "POST",
        headers: context.headers(true),
        body: JSON.stringify({
          reason: "uppercase self disable must fail",
          expectedAuthorizationRevision: current?.authorizationRevision
        })
      }
    );
    expect(disable.status).toBe(409);
    expect(await disable.json()).toMatchObject({ code: "self_disable" });

    const demote = await fetch(
      `${context.baseUrl}/api/admin/users/${uppercaseId}/permissions`,
      {
        method: "PATCH",
        headers: context.headers(true),
        body: JSON.stringify({
          reason: "uppercase self demotion must fail",
          expectedAuthorizationRevision: current?.authorizationRevision,
          appRole: "user"
        })
      }
    );
    expect(demote.status).toBe(409);
    expect(await demote.json()).toMatchObject({ code: "self_demote" });

    const usefulChange = await fetch(
      `${context.baseUrl}/api/admin/users/${uppercaseId}/permissions`,
      {
        method: "PATCH",
        headers: context.headers(true),
        body: JSON.stringify({
          reason: "retain admin while changing own trading permission",
          expectedAuthorizationRevision: current?.authorizationRevision,
          tradingRole: "read-only"
        })
      }
    );
    expect(usefulChange.status).toBe(200);
    expect(await usefulChange.json()).toMatchObject({
      user: { id: context.adminId, tradingRole: "read-only" },
      revokedSessionCount: 1,
      revokedCurrentSession: true
    });
    expect(usefulChange.headers.get("set-cookie")).toContain("Max-Age=0");
  });
});

async function startIdentityServer(): Promise<{
  baseUrl: string;
  adminId: string;
  service: IdentityService;
  credentials: Awaited<ReturnType<IdentityService["login"]>>;
  headers(mutation?: boolean): Record<string, string>;
}> {
  const repository = new MemoryIdentityRepository();
  const service = new IdentityService(repository);
  const admin = await service.bootstrapAdmin(
    "route-admin",
    "temporary-Admin-password-2026"
  );
  await repository.updateUser(admin.id, {
    mustChangePassword: false,
    updatedAt: new Date()
  });
  const credentials = await service.login(
    admin.login,
    "temporary-Admin-password-2026"
  );
  const routers = createIdentityRouters(service);
  const app = express();
  app.use("/api/auth", routers.auth);
  app.use("/api/admin", routers.admin);
  app.use(
    (
      _error: unknown,
      _request: express.Request,
      response: express.Response,
      _next: express.NextFunction
    ) => {
      response
        .status(500)
        .json({ error: "Internal server error.", code: "internal_error" });
    }
  );
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as AddressInfo;
  const cookie = `${sessionCookieName}=${encodeURIComponent(credentials.sessionToken)}; ${csrfCookieName}=${encodeURIComponent(credentials.csrfToken)}`;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    adminId: admin.id,
    service,
    credentials,
    headers(mutation = false) {
      return {
        cookie,
        ...(mutation
          ? {
              "content-type": "application/json",
              "x-csrf-token": credentials.csrfToken
            }
          : {})
      };
    }
  };
}

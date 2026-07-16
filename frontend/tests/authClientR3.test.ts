// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { activateUser, listAdminAudit, listOwnSessions, listUsers, revokeAdminUserSession, revokeAllAdminUserSessions, revokeOtherSessions, revokeOwnSession, updateUserPermissions } from "../src/auth/client";
import { AUTH_SESSION_INVALIDATED_EVENT } from "../src/auth/sessionSync";

const CURRENT_SESSION_ID = "00000000-0000-4000-8000-000000000011";
const OTHER_SESSION_ID = "00000000-0000-4000-8000-000000000012";
const ADMIN_ID = "00000000-0000-4000-8000-000000000001";
const ROMAN_ID = "00000000-0000-4000-8000-000000000002";

afterEach(() => {
  vi.unstubAllGlobals();
  document.cookie = "sbv2_csrf=; Max-Age=0";
});

describe("R3.1 authentication client", () => {
  it("sends server-side user filters and accepts the documented top-level pagination", async () => {
    const fetchMock = vi.fn(async () =>
      json({
        users: [user()],
        page: 2,
        pageSize: 10,
        total: 31,
        totalPages: 4
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await listUsers({ query: "roman", status: "active", appRole: "user", tradingRole: "paper-trade", page: 2, pageSize: 10 });
    const request = new URL(String(fetchMock.mock.calls[0]?.[0]), "http://localhost");
    expect(Object.fromEntries(request.searchParams)).toEqual({
      query: "roman",
      status: "active",
      appRole: "user",
      tradingRole: "paper-trade",
      page: "2",
      pageSize: "10"
    });
    expect(result.pagination).toEqual({ page: 2, pageSize: 10, total: 31, totalPages: 4 });
    expect(result.users[0]?.authorizationRevision).toBe(7);
  });

  it("sends one atomic activation body and parses revocation outcomes", async () => {
    document.cookie = "sbv2_csrf=csrf-r3";
    const fetchMock = vi.fn(async () =>
      json({
        user: { ...user(), status: "active", tradingRole: "paper-trade", authorizationRevision: 8 },
        revokedSessionCount: 3,
        cancelledJobCount: 2,
        revokedCurrentSession: false
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await activateUser(ROMAN_ID, {
      reason: "Pilot account reviewed.",
      expectedAuthorizationRevision: 7,
      tradingRole: "paper-trade"
    });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("X-CSRF-Token")).toBe("csrf-r3");
    expect(JSON.parse(String(init?.body))).toEqual({
      reason: "Pilot account reviewed.",
      expectedAuthorizationRevision: 7,
      tradingRole: "paper-trade"
    });
    expect(result).toMatchObject({ revokedSessionCount: 3, cancelledJobCount: 2, revokedCurrentSession: false, user: { authorizationRevision: 8 } });
  });

  it("strictly parses current-session revocation for direct self permissions", async () => {
    document.cookie = "sbv2_csrf=csrf-r3";
    const fetchMock = vi.fn(async () =>
      json({
        user: { ...user(), id: ADMIN_ID, login: "owner", appRole: "admin", authorizationRevision: 8 },
        revokedSessionCount: 1,
        cancelledJobCount: 0,
        revokedCurrentSession: true
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await updateUserPermissions(ADMIN_ID, {
      reason: "Reapply administrator permissions.",
      expectedAuthorizationRevision: 7,
      tradingRole: "none"
    });

    expect(result.revokedCurrentSession).toBe(true);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      reason: "Reapply administrator permissions.",
      expectedAuthorizationRevision: 7,
      tradingRole: "none"
    });
  });

  it("rejects an admin mutation response without an explicit current-session boolean", async () => {
    document.cookie = "sbv2_csrf=csrf-r3";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({
          user: user(),
          revokedSessionCount: 0,
          cancelledJobCount: 0
        })
      )
    );

    await expect(
      activateUser(ROMAN_ID, {
        reason: "Review incomplete response.",
        expectedAuthorizationRevision: 7
      })
    ).rejects.toMatchObject({ code: "invalid_response", status: 500 });
  });

  it("parses nested session/audit pagination and uses the explicit session revoke route", async () => {
    document.cookie = "sbv2_csrf=csrf-r3";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        json({
          sessions: [
            {
              publicId: CURRENT_SESSION_ID,
              current: true,
              createdAt: "2026-07-16T10:00:00.000Z",
              lastSeenAt: "2026-07-16T11:00:00.000Z",
              expiresAt: "2026-07-16T22:00:00.000Z"
            },
            {
              publicId: OTHER_SESSION_ID,
              current: false,
              createdAt: "2026-07-15T10:00:00.000Z",
              lastSeenAt: "2026-07-15T11:00:00.000Z",
              expiresAt: "2026-07-16T20:00:00.000Z",
              revokedAt: "2026-07-16T12:00:00.000Z",
              revokeReason: "session_revoked"
            }
          ],
          revocableSessionCount: 1,
          pagination: { page: 1, pageSize: 25, total: 2, totalPages: 1 }
        })
      )
      .mockResolvedValueOnce(
        json({
          revokedSessionCount: 1,
          revokedCurrentSession: true
        })
      )
      .mockResolvedValueOnce(
        json({
          events: [
            {
              id: "audit-1",
              eventType: "user.permissions_changed",
              actorLogin: "owner",
              subjectLogin: "roman",
              reason: "Paper pilot.",
              before: { tradingRole: "none", authorizationRevision: 1 },
              after: { tradingRole: "paper-trade", authorizationRevision: 2 },
              metadata: {},
              occurredAt: "2026-07-16T12:00:00.000Z"
            }
          ],
          pagination: { page: 1, pageSize: 25, total: 1, totalPages: 1 }
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    const sessions = await listOwnSessions();
    expect(sessions).toMatchObject({
      revocableSessionCount: 1,
      pagination: { total: 2 }
    });
    expect(sessions.sessions).toEqual([expect.objectContaining({ publicId: CURRENT_SESSION_ID, current: true }), expect.objectContaining({ publicId: OTHER_SESSION_ID, revokedAt: "2026-07-16T12:00:00.000Z" })]);
    const outcome = await revokeOwnSession(CURRENT_SESSION_ID);
    expect(outcome).toEqual({ revokedSessionCount: 1, revokedCurrentSession: true });
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(`/api/auth/sessions/${CURRENT_SESSION_ID}/revoke`);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ reason: "Self-service session revocation." });
    const audit = await listAdminAudit({ eventType: "user.permissions_changed" });
    expect(audit.events[0]).toMatchObject({
      reason: "Paper pilot.",
      before: { tradingRole: "none", authorizationRevision: 1 },
      after: { tradingRole: "paper-trade", authorizationRevision: 2 }
    });
  });

  it("returns authoritative outcomes for bulk and administrator session revocations", async () => {
    document.cookie = "sbv2_csrf=csrf-r3";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ revokedSessionCount: 2, revokedCurrentSession: false }))
      .mockResolvedValueOnce(json({ revokedSessionCount: 1, revokedCurrentSession: false }))
      .mockResolvedValueOnce(json({ revokedSessionCount: 3, revokedCurrentSession: true }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(revokeOtherSessions()).resolves.toEqual({
      revokedSessionCount: 2,
      revokedCurrentSession: false
    });
    await expect(revokeAdminUserSession(ADMIN_ID, OTHER_SESSION_ID, "Lost device.")).resolves.toEqual({
      revokedSessionCount: 1,
      revokedCurrentSession: false
    });
    await expect(revokeAllAdminUserSessions(ADMIN_ID, "Emergency account lock.")).resolves.toEqual({
      revokedSessionCount: 3,
      revokedCurrentSession: true
    });

    expect(fetchMock.mock.calls.map(([path, init]) => [String(path), init?.method])).toEqual([
      ["/api/auth/sessions/revoke-others", "POST"],
      [`/api/admin/users/${ADMIN_ID}/sessions/${OTHER_SESSION_ID}/revoke`, "POST"],
      [`/api/admin/users/${ADMIN_ID}/sessions/revoke-all`, "POST"]
    ]);
  });

  it("rejects an invalid audit subject before making a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(listAdminAudit({ subjectUserId: "roman" })).rejects.toMatchObject({
      status: 400,
      code: "invalid_user_id"
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("announces authoritative unauthorized responses without treating bad credentials as revocation", async () => {
    let invalidations = 0;
    window.addEventListener(
      AUTH_SESSION_INVALIDATED_EVENT,
      () => {
        invalidations += 1;
      },
      { once: true }
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ code: "not_authenticated", error: "Session ended." }, 401))
    );

    await expect(listUsers()).rejects.toMatchObject({ code: "not_authenticated" });
    expect(invalidations).toBe(1);
  });
});

function user() {
  return {
    id: ROMAN_ID,
    login: "roman",
    status: "active",
    appRole: "user",
    tradingRole: "none",
    mustChangePassword: false,
    authorizationRevision: 7
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import { installMarketSocketMock, mockCandleHistory, mockChartCandles } from "./support/marketMocks";

const ADMIN_ID = "00000000-0000-4000-8000-000000000001";
const ROMAN_ID = "00000000-0000-4000-8000-000000000002";
const LEGACY_ID = "00000000-0000-4000-8000-000000000003";
const CURRENT_SESSION_ID = "00000000-0000-4000-8000-000000000011";
const OTHER_SESSION_ID = "00000000-0000-4000-8000-000000000012";
const REVOKED_SESSION_ID = "00000000-0000-4000-8000-000000000013";
const ACTIVATION_REASON = "Approved for supervised paper trading.";
const ADMIN_SESSION_REASON = "Close this administrator browser.";

const viewports = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile-390", width: 390, height: 844 },
  { name: "mobile-320", width: 320, height: 700 }
] as const;

for (const viewport of viewports) {
  test(`R3.1 account and atomic admin activation stay usable on ${viewport.name}`, async ({ page }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const fixture = await installDatabaseAuthFixture(page);
    const candles = mockChartCandles();
    await page.addInitScript(() => localStorage.setItem("sbv2:locale", "en"));
    await mockCandleHistory(page, candles);
    await installMarketSocketMock(page, "stable", candles);

    await page.goto("/");
    await expect(page.getByRole("navigation", { name: "Primary workspaces" })).toBeVisible({ timeout: 20_000 });
    await openAccount(page);

    await expect(page.getByRole("dialog", { name: "Account" })).toBeVisible();
    const dialog = page.locator("dialog.auth-account-dialog");
    await expect(dialog.getByRole("heading", { name: "Sessions" })).toBeVisible();
    await expect(dialog.locator(".auth-session-card")).toHaveCount(3);
    await expect(dialog.getByText("Current session", { exact: true })).toBeVisible();
    await expect(dialog.getByText("Session ended.", { exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "End all other sessions" })).toBeVisible();

    await dialog.getByRole("tab", { name: "Administration" }).click();
    await expect(dialog.getByRole("heading", { name: "Users", exact: true })).toBeVisible();

    const romanCard = dialog.getByRole("article", { name: "roman", exact: true });
    await expect(romanCard).toBeVisible();
    const tradingRole = romanCard.getByRole("combobox", { name: "Trading access: roman" });
    await expect(tradingRole.locator('option[value="live-trade"]')).toHaveCount(0);
    await tradingRole.selectOption("paper-trade");
    await romanCard.getByRole("button", { name: "Activate: roman" }).click();

    const review = romanCard.getByRole("group", { name: "Review administrative change: roman" });
    await expect(review).toBeVisible();
    await expect(review.locator(".auth-change-preview")).toContainText("Before");
    await expect(review.locator(".auth-change-preview")).toContainText("Pending");
    await expect(review.locator(".auth-change-preview")).toContainText("Not granted");
    await expect(review.locator(".auth-change-preview")).toContainText("After");
    await expect(review.locator(".auth-change-preview")).toContainText("Active");
    await expect(review.locator(".auth-change-preview")).toContainText("Paper trading");
    const confirm = review.getByRole("button", { name: "Confirm change" });
    await expect(confirm).toBeDisabled();
    await review.getByRole("textbox", { name: "Reason" }).fill(ACTIVATION_REASON);
    await expect(confirm).toBeEnabled();
    await confirm.click();

    await expect.poll(() => fixture.activationBodies.length).toBe(1);
    expect(fixture.activationBodies[0]).toEqual({
      reason: ACTIVATION_REASON,
      expectedAuthorizationRevision: 3,
      tradingRole: "paper-trade"
    });
    await expect(romanCard).toContainText("Active");
    await expect(romanCard).toContainText("Paper trading");

    await dialog.getByRole("tab", { name: "Audit", exact: true }).click();
    await expect(dialog.getByRole("heading", { name: "Administrator audit" })).toBeVisible();
    const auditCard = dialog.locator("article.auth-audit-card").filter({ hasText: "user.activated" }).first();
    await expect(auditCard).toContainText(ACTIVATION_REASON);
    await expect(auditCard.locator(".auth-change-preview")).toContainText("Pending");
    await expect(auditCard.locator(".auth-change-preview")).toContainText("Not granted");
    await expect(auditCard.locator(".auth-change-preview")).toContainText("Active");
    await expect(auditCard.locator(".auth-change-preview")).toContainText("Paper trading");

    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    await assertDialogControlsReachable(dialog, viewport);

    await dialog.getByRole("tab", { name: "Users", exact: true }).click();
    const ownerCard = dialog.getByRole("article", { name: "owner", exact: true });
    await ownerCard.getByRole("button", { name: "View sessions: owner" }).click();
    const currentSessionCard = ownerCard.locator(".auth-session-card").filter({ hasText: "Current session" });
    await expect(currentSessionCard).toBeVisible();
    await currentSessionCard.getByRole("button", { name: /End session:/u }).click();
    const sessionReview = ownerCard.getByRole("group", { name: "Review administrative change" });
    await sessionReview.getByRole("textbox", { name: "Reason" }).fill(ADMIN_SESSION_REASON);
    await sessionReview.getByRole("button", { name: "Confirm change" }).click();

    await expect.poll(() => fixture.adminSessionRevocations.length).toBe(1);
    expect(fixture.adminSessionRevocations[0]).toEqual({
      userId: ADMIN_ID,
      publicId: CURRENT_SESSION_ID,
      reason: ADMIN_SESSION_REASON
    });
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  });
}

async function openAccount(page: Page) {
  const account = page.getByRole("button", { name: "Account: owner" });
  if (!(await account.isVisible())) {
    const moreTools = page.getByRole("button", { name: "More tools" });
    await moreTools.click();
    await expect(moreTools).toHaveAttribute("aria-expanded", "true");
  }
  await expect(account).toBeVisible();
  await account.click();
}

async function assertDialogControlsReachable(dialog: Locator, viewport: { width: number; height: number }) {
  await expect(dialog.getByRole("button", { name: "Close" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Sign out" })).toBeVisible();
  const closeBox = await dialog.getByRole("button", { name: "Close" }).boundingBox();
  const signOutBox = await dialog.getByRole("button", { name: "Sign out" }).boundingBox();
  expect(closeBox).not.toBeNull();
  expect(signOutBox).not.toBeNull();
  const geometry = await dialog.evaluate((element) => {
    const dialogBox = element.getBoundingClientRect();
    const body = element.querySelector<HTMLElement>(".auth-dialog-body");
    return {
      dialog: dialogBox.toJSON(),
      bodyOverflow: body ? body.scrollWidth - body.clientWidth : Number.POSITIVE_INFINITY
    };
  });
  expect(geometry.dialog.x).toBeGreaterThanOrEqual(-1);
  expect(geometry.dialog.y).toBeGreaterThanOrEqual(-1);
  expect(geometry.dialog.right).toBeLessThanOrEqual(viewport.width + 1);
  expect(geometry.dialog.bottom).toBeLessThanOrEqual(viewport.height + 1);
  expect(geometry.bodyOverflow).toBeLessThanOrEqual(1);
  for (const control of [closeBox!, signOutBox!]) {
    expect(control.x).toBeGreaterThanOrEqual(geometry.dialog.x - 1);
    expect(control.y).toBeGreaterThanOrEqual(geometry.dialog.y - 1);
    expect(control.x + control.width).toBeLessThanOrEqual(geometry.dialog.right + 1);
    expect(control.y + control.height).toBeLessThanOrEqual(geometry.dialog.bottom + 1);
    expect(control.width).toBeGreaterThanOrEqual(32);
    expect(control.height).toBeGreaterThanOrEqual(32);
  }
}

async function installDatabaseAuthFixture(page: Page) {
  const activationBodies: Record<string, unknown>[] = [];
  const adminSessionRevocations: Array<{ userId: string; publicId: string; reason: string }> = [];
  let authenticated = true;
  let users = [
    userFixture({
      id: ADMIN_ID,
      login: "owner",
      status: "active",
      appRole: "admin",
      tradingRole: "none",
      authorizationRevision: 7,
      createdAt: "2026-07-15T08:00:00.000Z",
      lastLoginAt: "2026-07-16T12:00:00.000Z"
    }),
    userFixture({
      id: ROMAN_ID,
      login: "roman",
      status: "pending",
      appRole: "user",
      tradingRole: "none",
      authorizationRevision: 3,
      createdAt: "2026-07-16T09:00:00.000Z"
    }),
    userFixture({
      id: LEGACY_ID,
      login: "legacy-live",
      status: "active",
      appRole: "user",
      tradingRole: "live-trade",
      authorizationRevision: 4,
      createdAt: "2026-07-14T09:00:00.000Z",
      lastLoginAt: "2026-07-15T10:00:00.000Z"
    })
  ];
  let sessions = [
    sessionFixture({
      publicId: CURRENT_SESSION_ID,
      current: true,
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36",
      ipAddress: "127.0.0.1"
    }),
    sessionFixture({
      publicId: OTHER_SESSION_ID,
      current: false,
      userAgent: "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36 OPR/85.0",
      ipAddress: "198.51.100.24"
    }),
    sessionFixture({
      publicId: REVOKED_SESSION_ID,
      current: false,
      revokedAt: "2026-07-16T10:30:00.000Z",
      revokeReason: "session_revoked",
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1",
      ipAddress: "203.0.113.17"
    })
  ];
  const auditEvents: Record<string, unknown>[] = [];

  await page.route("**/api/auth/config", (route) =>
    json(route, {
      mode: "database",
      authRequired: true,
      registrationEnabled: true,
      tradingRoleAssignmentsEnabled: true
    })
  );
  await page.route("**/api/auth/me", (route) =>
    authenticated
      ? json(route, {
          user: users[0],
          csrfToken: "csrf-e2e",
          expiresAt: "2026-07-17T12:00:00.000Z",
          tradingAvailable: true
        })
      : json(
          route,
          {
            code: "not_authenticated",
            error: "Authentication is required."
          },
          401
        )
  );
  await page.route("**/api/auth/sessions**", async (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    if (!authenticated) {
      return json(
        route,
        {
          code: "not_authenticated",
          error: "Authentication is required."
        },
        401
      );
    }
    if (request.method() === "GET" && pathname === "/api/auth/sessions") {
      return json(route, sessionPageResult(sessions));
    }
    if (request.method() === "POST" && pathname === "/api/auth/sessions/revoke-others") {
      let revokedSessionCount = 0;
      sessions = sessions.map((session) => {
        if (session.current || session.revokedAt) return session;
        revokedSessionCount += 1;
        return {
          ...session,
          revokedAt: "2026-07-16T12:20:00.000Z",
          revokeReason: "sessions_others_revoked"
        };
      });
      return json(route, {
        revokedSessionCount,
        revokedCurrentSession: false
      });
    }
    if (request.method() === "POST" && /^\/api\/auth\/sessions\/[^/]+\/revoke$/u.test(pathname)) {
      const publicId = decodeURIComponent(pathname.split("/").at(-2) ?? "");
      const target = sessions.find((session) => session.publicId === publicId && !session.revokedAt);
      if (!target) return json(route, { code: "session_not_found", error: "Session not found." }, 404);
      sessions = sessions.map((session) =>
        session.publicId === publicId
          ? {
              ...session,
              revokedAt: "2026-07-16T12:20:00.000Z",
              revokeReason: "session_revoked"
            }
          : session
      );
      if (target.current) authenticated = false;
      return json(route, {
        revokedSessionCount: 1,
        revokedCurrentSession: target.current
      });
    }
    return json(route, { code: "unexpected_auth_session_request" }, 500);
  });
  await page.route("**/api/admin/users**", async (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    if (!authenticated) {
      return json(
        route,
        {
          code: "not_authenticated",
          error: "Authentication is required."
        },
        401
      );
    }
    if (request.method() === "GET" && pathname === "/api/admin/users") {
      return json(route, pageResult("users", users));
    }
    const activation = pathname.match(/^\/api\/admin\/users\/([^/]+)\/activate$/u);
    if (request.method() === "POST" && activation) {
      const userId = decodeURIComponent(activation[1]);
      const body = request.postDataJSON() as Record<string, unknown>;
      activationBodies.push(body);
      const before = users.find((user) => user.id === userId);
      if (!before) return json(route, { code: "user_not_found" }, 404);
      const appRole = body.appRole === "admin" || body.appRole === "user" ? body.appRole : before.appRole;
      const tradingRole = body.tradingRole === "none" || body.tradingRole === "read-only" || body.tradingRole === "paper-trade" ? body.tradingRole : before.tradingRole;
      const after = {
        ...before,
        status: "active",
        appRole,
        tradingRole,
        authorizationRevision: before.authorizationRevision + 1,
        approvedBy: ADMIN_ID,
        approvedAt: "2026-07-16T12:15:00.000Z",
        updatedAt: "2026-07-16T12:15:00.000Z"
      };
      users = users.map((user) => (user.id === userId ? after : user));
      auditEvents.unshift({
        id: "91",
        eventType: "user.activated",
        actorUserId: ADMIN_ID,
        actorLogin: "owner",
        subjectUserId: before.id,
        subjectLogin: before.login,
        requestId: "r3-e2e-activation",
        reason: body.reason,
        before: auditState(before),
        after: auditState(after),
        metadata: { source: "playwright" },
        occurredAt: "2026-07-16T12:15:00.000Z"
      });
      return json(route, {
        user: after,
        revokedSessionCount: 0,
        cancelledJobCount: 0,
        revokedCurrentSession: false
      });
    }
    const adminSessions = pathname.match(/^\/api\/admin\/users\/([^/]+)\/sessions$/u);
    if (request.method() === "GET" && adminSessions) {
      const userId = decodeURIComponent(adminSessions[1]);
      const visibleSessions = sessions.map((session) => ({
        ...session,
        current: userId === ADMIN_ID && session.current
      }));
      return json(route, sessionPageResult(visibleSessions));
    }
    const adminSessionRevoke = pathname.match(/^\/api\/admin\/users\/([^/]+)\/sessions\/([^/]+)\/revoke$/u);
    if (request.method() === "POST" && adminSessionRevoke) {
      const userId = decodeURIComponent(adminSessionRevoke[1]);
      const publicId = decodeURIComponent(adminSessionRevoke[2]);
      const body = request.postDataJSON() as { reason?: unknown };
      const reason = typeof body.reason === "string" ? body.reason : "";
      adminSessionRevocations.push({ userId, publicId, reason });
      const target = sessions.find((session) => session.publicId === publicId && !session.revokedAt);
      if (!target) return json(route, { code: "session_not_found", error: "Session not found." }, 404);
      sessions = sessions.map((session) =>
        session.publicId === publicId
          ? {
              ...session,
              revokedAt: "2026-07-16T12:30:00.000Z",
              revokeReason: "admin_session_revoked"
            }
          : session
      );
      const revokedCurrentSession = userId === ADMIN_ID && target.current;
      if (revokedCurrentSession) authenticated = false;
      return json(route, {
        revokedSessionCount: 1,
        revokedCurrentSession
      });
    }
    return json(route, { code: "unexpected_admin_user_request" }, 500);
  });
  await page.route("**/api/admin/audit**", (route) => json(route, pageResult("events", auditEvents)));

  return { activationBodies, adminSessionRevocations };
}

interface UserFixture {
  id: string;
  login: string;
  status: "pending" | "active" | "disabled";
  appRole: "user" | "admin";
  tradingRole: "none" | "read-only" | "paper-trade" | "live-trade";
  mustChangePassword: boolean;
  authorizationRevision: number;
  approvedBy?: string;
  approvedAt?: string;
  lastLoginAt?: string;
  createdAt: string;
  updatedAt: string;
}

interface SessionFixture {
  publicId: string;
  current: boolean;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  revokedAt?: string;
  revokeReason?: string;
  userAgent?: string;
  ipAddress?: string;
}

function userFixture(overrides: Pick<UserFixture, "id" | "login"> & Partial<UserFixture>): UserFixture {
  return {
    id: "",
    login: "",
    status: "active",
    appRole: "user",
    tradingRole: "none",
    mustChangePassword: false,
    authorizationRevision: 1,
    createdAt: "2026-07-16T08:00:00.000Z",
    updatedAt: "2026-07-16T08:00:00.000Z",
    ...overrides
  };
}

function sessionFixture(overrides: Pick<SessionFixture, "publicId"> & Partial<SessionFixture>): SessionFixture {
  return {
    publicId: "",
    current: false,
    createdAt: "2026-07-16T08:00:00.000Z",
    lastSeenAt: "2026-07-16T12:00:00.000Z",
    expiresAt: "2026-07-17T12:00:00.000Z",
    ...overrides
  };
}

function auditState(user: UserFixture) {
  return {
    status: user.status,
    appRole: user.appRole,
    tradingRole: user.tradingRole,
    authorizationRevision: user.authorizationRevision
  };
}

function pageResult(key: "users" | "sessions" | "events", items: readonly unknown[]) {
  return {
    [key]: items,
    pagination: {
      page: 1,
      pageSize: 25,
      total: items.length,
      totalPages: items.length > 0 ? 1 : 0
    }
  };
}

function sessionPageResult(sessions: readonly SessionFixture[]) {
  return {
    ...pageResult("sessions", sessions),
    revocableSessionCount: sessions.filter((session) => !session.revokedAt).length
  };
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body)
  });
}

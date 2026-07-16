// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountDialog } from "../src/auth/AccountDialog";
import { authText } from "../src/auth/messages";
import type { AuthSessionSummary, AuthUser } from "../src/auth/types";

const ADMIN_ID = "00000000-0000-4000-8000-000000000001";
const ROMAN_ID = "00000000-0000-4000-8000-000000000002";
const LEGACY_ID = "00000000-0000-4000-8000-000000000003";
const CURRENT_SESSION_ID = "00000000-0000-4000-8000-000000000011";
const ROMAN_PHONE_SESSION_ID = "00000000-0000-4000-8000-000000000021";
const admin = user({ id: ADMIN_ID, login: "owner", appRole: "admin" });
const roman = user({ id: ROMAN_ID, login: "roman", status: "pending" });
const legacy = user({ id: LEGACY_ID, login: "legacy", tradingRole: "live-trade" });

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.setAttribute("open", "");
    }
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.removeAttribute("open");
      this.dispatchEvent(new Event("close"));
    }
  });
});

afterEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("AccountDialog R3.1 administration", () => {
  it("activates a pending user atomically only after a reason and before/after review", async () => {
    const api = mockApi([admin, roman]);
    const view = await renderDialog(admin);
    await openAdministration(view.container);
    const statusFilter = view.container.querySelector<HTMLSelectElement>(".auth-user-filters select")!;
    await changeSelect(statusFilter, "pending");
    await vi.waitFor(() => expect(api.userQueries.some((query) => query.get("status") === "pending")).toBe(true));
    const filteredGetsBeforeMutation = api.userQueries.filter((query) => query.get("status") === "pending").length;

    const card = await waitForCard(view.container, "roman");
    await changeSelect(card.querySelector<HTMLSelectElement>(`select[aria-label="${authText("en", "tradingRole")}: roman"]`)!, "paper-trade");
    await click(buttonFor(card, authText("en", "activate")));

    const reason = card.querySelector<HTMLTextAreaElement>("textarea")!;
    const confirm = buttonFor(card, authText("en", "confirmAction"));
    expect(reason).not.toBeNull();
    expect(confirm.disabled).toBe(true);
    expect(card.querySelector(".auth-change-preview")?.textContent).toContain(authText("en", "before"));
    expect(card.querySelector(".auth-change-preview")?.textContent).toContain(authText("en", "after"));

    await changeTextarea(reason, "Reviewed paper access for the pilot.");
    expect(confirm.disabled).toBe(false);
    await click(confirm);

    await vi.waitFor(() => expect(api.users.get(roman.id)).toMatchObject({ status: "active", tradingRole: "paper-trade" }));
    await vi.waitFor(() => expect(api.userQueries.filter((query) => query.get("status") === "pending").length).toBe(filteredGetsBeforeMutation + 1));
    expect(Object.fromEntries(api.userQueries.at(-1) ?? [])).toMatchObject({
      status: "pending",
      page: "1",
      pageSize: "25"
    });
    expect(api.mutations).toHaveLength(1);
    expect(api.mutations[0]).toEqual({
      method: "POST",
      path: `/api/admin/users/${ROMAN_ID}/activate`,
      body: {
        reason: "Reviewed paper access for the pilot.",
        expectedAuthorizationRevision: 1,
        tradingRole: "paper-trade"
      }
    });
    expect(card.textContent).toContain(authText("en", "userActivated"));
    await unmount(view.root);
  });

  it("shows an existing live role as dormant and never offers it as an assignable role", async () => {
    mockApi([admin, roman, legacy]);
    const view = await renderDialog(admin);
    await openAdministration(view.container);

    const legacyCard = await waitForCard(view.container, "legacy");
    const legacySelect = legacyCard.querySelector<HTMLSelectElement>(`select[aria-label="${authText("en", "tradingRole")}: legacy"]`)!;
    expect(legacySelect.value).toBe("live-trade");
    expect(legacySelect.querySelector<HTMLOptionElement>('option[value="live-trade"]')?.disabled).toBe(true);
    expect(legacyCard.textContent).toContain(authText("en", "dormantLiveTradeHelp"));

    const romanCard = await waitForCard(view.container, "roman");
    const romanSelect = romanCard.querySelector<HTMLSelectElement>(`select[aria-label="${authText("en", "tradingRole")}: roman"]`)!;
    expect(romanSelect.querySelector('option[value="live-trade"]')).toBeNull();
    expect([...romanSelect.options].map((option) => option.value)).toEqual(["none", "read-only", "paper-trade"]);
    await unmount(view.root);
  });

  it("uses server filters and pagination instead of filtering the downloaded page locally", async () => {
    const api = mockApi([admin, roman], { total: 30 });
    const view = await renderDialog(admin);
    await openAdministration(view.container);

    const search = view.container.querySelector<HTMLInputElement>('.auth-user-filters input[type="search"]')!;
    expect(search.maxLength).toBe(64);
    await changeInput(search, "ROM");
    await submit(search.closest("form")!);
    await vi.waitFor(() => expect(api.userQueries.some((query) => query.get("query") === "ROM")).toBe(true));

    const next = buttonFor(view.container, authText("en", "nextPage"));
    await click(next);
    await vi.waitFor(() => expect(api.userQueries.some((query) => query.get("page") === "2")).toBe(true));
    await unmount(view.root);
  });

  it("requires a reason before an administrator can end a selected user session", async () => {
    const api = mockApi([admin, roman], {
      adminSessions: [session({ publicId: ROMAN_PHONE_SESSION_ID, userAgent: "Mozilla/5.0 (Linux; Android 14) Chrome/120.0" })]
    });
    const view = await renderDialog(admin);
    await openAdministration(view.container);
    const card = await waitForCard(view.container, "roman");
    await click(buttonFor(card, authText("en", "viewSessions")));
    await vi.waitFor(() => expect(card.textContent).toContain("Chrome · Android"));

    await click(buttonFor(card, authText("en", "revokeSession")));
    const reason = card.querySelector<HTMLTextAreaElement>(".auth-admin-sessions textarea")!;
    const confirm = buttonFor(card.querySelector(".auth-admin-sessions")!, authText("en", "confirmAction"));
    expect(confirm.disabled).toBe(true);
    await changeTextarea(reason, "Lost phone reported by the user.");
    await click(confirm);

    await vi.waitFor(() => expect(api.mutations.some((mutation) => mutation.path.endsWith(`/sessions/${ROMAN_PHONE_SESSION_ID}/revoke`))).toBe(true));
    expect(api.mutations.find((mutation) => mutation.path.endsWith(`/sessions/${ROMAN_PHONE_SESSION_ID}/revoke`))?.body).toEqual({ reason: "Lost phone reported by the user." });
    await vi.waitFor(() => expect(card.textContent).toContain(authText("en", "sessionRevoked")));
    expect(card.textContent).toContain("Chrome · Android");
    await unmount(view.root);
  });

  it("reconciles the account when an administrator revokes their own current session", async () => {
    mockApi([admin, roman], {
      adminSessions: [
        session({
          publicId: CURRENT_SESSION_ID,
          current: true,
          userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/120.0"
        })
      ],
      adminRevocationOutcome: {
        revokedSessionCount: 1,
        revokedCurrentSession: true
      }
    });
    const changed = vi.fn(async () => {});
    const view = await renderDialog(admin, changed);
    await openAdministration(view.container);
    const card = await waitForCard(view.container, "owner");
    expect(card.querySelector<HTMLSelectElement>(`select[aria-label="${authText("en", "appRole")}: owner"]`)?.disabled).toBe(true);
    expect(card.querySelector<HTMLSelectElement>(`select[aria-label="${authText("en", "tradingRole")}: owner"]`)?.disabled).toBe(true);
    expect(buttonFor(card, authText("en", "savePermissions")).disabled).toBe(true);
    expect(buttonFor(card, authText("en", "disable")).disabled).toBe(true);
    await click(buttonFor(card, authText("en", "viewSessions")));
    await vi.waitFor(() => expect(card.textContent).toContain(authText("en", "currentSession")));

    await click(buttonFor(card, authText("en", "revokeSession")));
    await changeTextarea(card.querySelector<HTMLTextAreaElement>(".auth-admin-sessions textarea")!, "Close this administrator browser.");
    await click(buttonFor(card.querySelector(".auth-admin-sessions")!, authText("en", "confirmAction")));

    await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
    await unmount(view.root);
  });

  it("reconciles an authoritative lifecycle current-session outcome without reloading users", async () => {
    const api = mockApi([admin, roman], { lifecycleRevokedCurrentSession: true });
    const changed = vi.fn(async () => {});
    const view = await renderDialog(admin, changed);
    await openAdministration(view.container);
    const getsBeforeMutation = api.userQueries.length;
    const card = await waitForCard(view.container, "roman");

    await click(buttonFor(card, authText("en", "activate")));
    await changeTextarea(card.querySelector<HTMLTextAreaElement>("textarea")!, "Approve and reconcile this session.");
    await click(buttonFor(card, authText("en", "confirmAction")));

    await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
    expect(api.userQueries).toHaveLength(getsBeforeMutation);
    await unmount(view.root);
  });
});

async function renderDialog(currentUser: AuthUser, onSessionChanged: () => Promise<void> = async () => {}): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<AccountDialog locale="en" onChangePassword={async () => {}} onClose={() => {}} onLogout={async () => {}} onSessionChanged={onSessionChanged} open tradingRoleAssignmentsEnabled user={currentUser} />);
    await Promise.resolve();
  });
  return { container, root };
}

async function openAdministration(container: HTMLElement): Promise<void> {
  await click(buttonFor(container, authText("en", "adminArea")));
  await vi.waitFor(() => expect(container.querySelectorAll("article.auth-user-card").length).toBeGreaterThan(0));
}

async function waitForCard(container: HTMLElement, login: string): Promise<HTMLElement> {
  let result: HTMLElement | undefined;
  await vi.waitFor(() => {
    result = [...container.querySelectorAll<HTMLElement>("article.auth-user-card")].find((card) => card.querySelector("strong")?.textContent === login);
    expect(result).toBeTruthy();
  });
  return result!;
}

function buttonFor(container: ParentNode, label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === label);
  if (!button) throw new Error(`Missing button: ${label}`);
  return button;
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
}

async function changeSelect(select: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function changeInput(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function changeTextarea(input: HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submit(form: HTMLFormElement): Promise<void> {
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
}

async function unmount(root: Root): Promise<void> {
  await act(async () => root.unmount());
}

function user(overrides: Partial<AuthUser>): AuthUser {
  return {
    id: "00000000-0000-4000-8000-000000000099",
    login: "user",
    status: "active",
    appRole: "user",
    tradingRole: "none",
    mustChangePassword: false,
    authorizationRevision: 1,
    ...overrides
  };
}

function session(overrides: Partial<AuthSessionSummary> = {}): AuthSessionSummary {
  return {
    publicId: "00000000-0000-4000-8000-000000000091",
    current: false,
    createdAt: "2026-07-16T10:00:00.000Z",
    lastSeenAt: "2026-07-16T11:00:00.000Z",
    expiresAt: "2026-07-16T22:00:00.000Z",
    ...overrides
  };
}

function mockApi(
  initialUsers: AuthUser[],
  options: {
    total?: number;
    adminSessions?: AuthSessionSummary[];
    adminRevocationOutcome?: {
      revokedSessionCount: number;
      revokedCurrentSession: boolean;
    };
    lifecycleRevokedCurrentSession?: boolean;
  } = {}
) {
  const users = new Map(initialUsers.map((item) => [item.id, { ...item }]));
  const mutations: Array<{ method: string; path: string; body?: unknown }> = [];
  const userQueries: URLSearchParams[] = [];
  let adminSessions = [...(options.adminSessions ?? [])];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(raw, "http://localhost");
      const method = (init.method ?? "GET").toUpperCase();
      if (url.pathname === "/api/auth/sessions" && method === "GET") {
        return sessionPage([session({ publicId: CURRENT_SESSION_ID, current: true })]);
      }
      if (url.pathname === "/api/admin/users" && method === "GET") {
        userQueries.push(new URLSearchParams(url.search));
        return paged({ users: [...users.values()] }, options.total ?? users.size);
      }
      const sessionList = url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/sessions$/);
      if (sessionList && method === "GET") return sessionPage(adminSessions);
      const sessionRevoke = url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/sessions\/([^/]+)\/revoke$/);
      if (sessionRevoke && method === "POST") {
        const body = JSON.parse(String(init.body));
        mutations.push({ method, path: url.pathname, body });
        const publicId = decodeURIComponent(sessionRevoke[2]!);
        const outcome = options.adminRevocationOutcome ?? {
          revokedSessionCount: 1,
          revokedCurrentSession: false
        };
        adminSessions = adminSessions.map((item) =>
          item.publicId === publicId
            ? {
                ...item,
                revokedAt: "2026-07-16T12:30:00.000Z",
                revokeReason: "admin_session_revoked"
              }
            : item
        );
        return json(outcome);
      }
      const activate = url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/(activate|reactivate)$/);
      if (activate && method === "POST") {
        const body = JSON.parse(String(init.body));
        mutations.push({ method, path: url.pathname, body });
        const id = decodeURIComponent(activate[1]!);
        const { reason: _reason, expectedAuthorizationRevision: _expectedRevision, ...permissions } = body as { reason: string; expectedAuthorizationRevision: number; appRole?: AuthUser["appRole"]; tradingRole?: AuthUser["tradingRole"] };
        const next = { ...users.get(id)!, ...permissions, status: "active" as const, authorizationRevision: users.get(id)!.authorizationRevision + 1 };
        users.set(id, next);
        return json({
          user: next,
          revokedSessionCount: options.lifecycleRevokedCurrentSession ? 1 : 0,
          cancelledJobCount: 0,
          revokedCurrentSession: options.lifecycleRevokedCurrentSession === true
        });
      }
      return json({ code: "not_found", error: "Not found." }, 404);
    })
  );
  return { mutations, userQueries, users };
}

function paged(body: object, total: number): Response {
  return json({ ...body, page: 1, pageSize: 25, total, totalPages: total > 25 ? 2 : total ? 1 : 0 });
}

function sessionPage(sessions: AuthSessionSummary[]): Response {
  return json({
    sessions,
    revocableSessionCount: sessions.filter((item) => !item.revokedAt).length,
    page: 1,
    pageSize: 25,
    total: sessions.length,
    totalPages: sessions.length ? 1 : 0
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

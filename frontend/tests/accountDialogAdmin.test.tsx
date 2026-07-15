// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountDialog } from "../src/auth/AccountDialog";
import { authText } from "../src/auth/messages";
import type { AuthUser } from "../src/auth/types";

const admin: AuthUser = {
  id: "admin-1",
  login: "owner",
  status: "active",
  appRole: "admin",
  tradingRole: "none",
  mustChangePassword: false
};

const roman: AuthUser = {
  id: "user-roman",
  login: "roman",
  status: "pending",
  appRole: "user",
  tradingRole: "none",
  mustChangePassword: false
};

const alice: AuthUser = {
  id: "user-alice",
  login: "alice",
  status: "disabled",
  appRole: "user",
  tradingRole: "read-only",
  mustChangePassword: false
};

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

describe("AccountDialog administration", () => {
  it("saves selected permissions before activating a pending user", async () => {
    const api = mockAdminApi([admin, roman]);
    const view = await renderDialog();
    await openAdministration(view.container);

    const card = await waitForCard(view.container, "roman");
    const tradingRole = card.querySelector<HTMLSelectElement>(`select[aria-label="${authText("en", "tradingRole")}: roman"]`)!;
    await changeSelect(tradingRole, "paper-trade");

    const activate = buttonFor(card, authText("en", "saveAndActivate"));
    expect(activate.getAttribute("aria-label")).toContain("roman");
    await click(activate);

    await vi.waitFor(() => expect(api.users.get(roman.id)).toMatchObject({ status: "active", tradingRole: "paper-trade" }));
    expect(api.mutations.map(({ method, path }) => `${method} ${path}`)).toEqual(["PATCH /api/admin/users/user-roman/permissions", "POST /api/admin/users/user-roman/activate"]);
    expect(api.mutations[0]?.body).toEqual({ appRole: "user", tradingRole: "paper-trade" });
    expect(card.textContent).toContain(authText("en", "userActivatedWithPermissions"));
    await unmount(view.root);
  });

  it("does not activate when saving the selected permissions fails", async () => {
    const api = mockAdminApi([admin, roman], { failPermissions: true });
    const view = await renderDialog();
    await openAdministration(view.container);

    const card = await waitForCard(view.container, "roman");
    const tradingRole = card.querySelector<HTMLSelectElement>(`select[aria-label="${authText("en", "tradingRole")}: roman"]`)!;
    await changeSelect(tradingRole, "live-trade");
    await click(buttonFor(card, authText("en", "saveAndActivate")));

    await vi.waitFor(() => expect(card.querySelector('[role="alert"]')).not.toBeNull());
    expect(api.mutations.map(({ method, path }) => `${method} ${path}`)).toEqual(["PATCH /api/admin/users/user-roman/permissions"]);
    expect(api.users.get(roman.id)?.status).toBe("pending");
    await unmount(view.root);
  });

  it("filters a larger user list and gives repeated cards and controls user-specific names", async () => {
    mockAdminApi([admin, roman, alice]);
    const view = await renderDialog();
    await openAdministration(view.container);

    const ownerCard = await waitForCard(view.container, "owner");
    const ownerRole = ownerCard.querySelector<HTMLSelectElement>(`select[aria-label="${authText("en", "appRole")}: owner"]`)!;
    expect(ownerRole.disabled).toBe(true);
    const helpId = ownerRole.getAttribute("aria-describedby");
    expect(helpId).toBeTruthy();
    expect(document.getElementById(helpId!)?.textContent).toBe(authText("en", "ownAdminRoleLocked"));

    for (const card of view.container.querySelectorAll<HTMLElement>("article.auth-user-card")) {
      const titleId = card.getAttribute("aria-labelledby");
      const login = titleId ? document.getElementById(titleId)?.textContent : undefined;
      expect(login).toBeTruthy();
      for (const control of card.querySelectorAll<HTMLButtonElement | HTMLSelectElement>("button, select")) {
        expect(control.getAttribute("aria-label")).toContain(login);
      }
    }

    const status = view.container.querySelector<HTMLSelectElement>(".auth-user-filters select")!;
    await changeSelect(status, "pending");
    expect(loginsIn(view.container)).toEqual(["roman"]);

    await changeSelect(status, "all");
    const search = view.container.querySelector<HTMLInputElement>('.auth-user-filters input[type="search"]')!;
    await changeInput(search, "ALI");
    expect(loginsIn(view.container)).toEqual(["alice"]);
    expect(view.container.querySelector(".auth-user-filters output")?.textContent).toContain("1 / 3");
    await unmount(view.root);
  });
});

async function renderDialog(): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<AccountDialog locale="en" onChangePassword={async () => {}} onClose={() => {}} onLogout={async () => {}} open tradingRoleAssignmentsEnabled user={admin} />);
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

function loginsIn(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLElement>("article.auth-user-card strong")].map((item) => item.textContent ?? "");
}

function buttonFor(container: HTMLElement, label: string): HTMLButtonElement {
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
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
    setter?.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function changeInput(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function unmount(root: Root): Promise<void> {
  await act(async () => root.unmount());
}

function mockAdminApi(initialUsers: AuthUser[], options: { failPermissions?: boolean } = {}) {
  const users = new Map(initialUsers.map((user) => [user.id, { ...user }]));
  const mutations: Array<{ method: string; path: string; body?: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const path = typeof input === "string" ? input : input instanceof URL ? input.pathname : new URL(input.url).pathname;
      const method = (init.method ?? "GET").toUpperCase();
      if (path === "/api/admin/users" && method === "GET") {
        return json({ users: [...users.values()] });
      }

      const permissions = path.match(/^\/api\/admin\/users\/([^/]+)\/permissions$/);
      if (permissions && method === "PATCH") {
        const body = JSON.parse(String(init.body)) as Partial<AuthUser>;
        mutations.push({ method, path, body });
        if (options.failPermissions) return json({ code: "trading_ownership_pending", error: "Trading roles are locked." }, 409);
        const id = decodeURIComponent(permissions[1]!);
        const next = { ...users.get(id)!, ...body };
        users.set(id, next);
        return json({ user: next });
      }

      const activate = path.match(/^\/api\/admin\/users\/([^/]+)\/activate$/);
      if (activate && method === "POST") {
        mutations.push({ method, path });
        const id = decodeURIComponent(activate[1]!);
        const next = { ...users.get(id)!, status: "active" as const };
        users.set(id, next);
        return json({ user: next });
      }

      return json({ code: "not_found", error: "Not found." }, 404);
    })
  );
  return { mutations, users };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

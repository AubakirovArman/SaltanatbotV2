// @vitest-environment jsdom
import { act, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthRoot, useAuth } from "../src/auth/AuthRoot";
import { writeTenantLocalItem } from "../src/app/tenantLocalStorage";
import { AUTH_SESSION_STORAGE_KEY, type AuthSessionChange } from "../src/auth/sessionSync";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("AuthRoot locale loading", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("sbv2:locale", "en");
    document.documentElement.lang = "en";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps an already bootstrapped application mounted while a new catalog loads", async () => {
    let resolveEnglish: ((response: Response) => void) | undefined;
    let resolveRussian: ((response: Response) => void) | undefined;
    const english = new Promise<Response>((resolve) => {
      resolveEnglish = resolve;
    });
    const russian = new Promise<Response>((resolve) => {
      resolveRussian = resolve;
    });
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const path = typeof input === "string" ? input : input instanceof URL ? input.pathname : new URL(input.url).pathname;
      if (path === "/api/auth/config") return Promise.resolve(json({ mode: "legacy", authRequired: false }));
      if (path === "/auth-i18n/ru.json") return russian;
      if (path === "/auth-i18n/en.json") return english;
      return Promise.resolve(json({}));
    });
    vi.stubGlobal("fetch", fetchMock);
    const container = document.createElement("div");
    const root = createRoot(container);

    function StatefulApplication() {
      const [count, setCount] = useState(0);
      return (
        <button type="button" onClick={() => setCount((value) => value + 1)}>
          Count {count}
        </button>
      );
    }

    await act(async () =>
      root.render(
        <AuthRoot>
          <StatefulApplication />
        </AuthRoot>
      )
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/auth-i18n/en.json", { cache: "force-cache" }));
    expect(container.querySelector("button")).toBeNull();
    await act(async () => {
      resolveEnglish?.(json({ product: "SaltanatbotV2" }));
    });
    await vi.waitFor(() => expect(container.querySelector("button")?.textContent).toBe("Count 0"));
    await act(async () => container.querySelector("button")?.click());
    expect(container.querySelector("button")?.textContent).toBe("Count 1");

    await act(async () => {
      document.documentElement.lang = "ru";
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/auth-i18n/ru.json", { cache: "force-cache" }));
    expect(container.querySelector("button")?.textContent).toBe("Count 1");

    await act(async () => {
      resolveRussian?.(json({ product: "SaltanatbotV2" }));
    });
    expect(container.querySelector("button")?.textContent).toBe("Count 1");
    await act(async () => root.unmount());
  });

  it("remounts private application state when a silent session refresh switches user id", async () => {
    const sessions = [authSession("user-a"), authSession("user-b")];
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const path = typeof input === "string" ? input : input instanceof URL ? input.pathname : new URL(input.url).pathname;
      if (path === "/api/auth/config") {
        return Promise.resolve(json({ mode: "database", authRequired: true, registrationEnabled: true, tradingRoleAssignmentsEnabled: true }));
      }
      if (path === "/api/auth/me") return Promise.resolve(json(sessions.shift()));
      if (path === "/auth-i18n/en.json") return Promise.resolve(json({ product: "SaltanatbotV2" }));
      return Promise.resolve(json({}));
    });
    vi.stubGlobal("fetch", fetchMock);
    const container = document.createElement("div");
    const root = createRoot(container);
    let mounts = 0;

    function TenantApplication() {
      const auth = useAuth();
      const ownerId = auth.user?.id ?? "";
      const [draft, setDraft] = useState("");
      useEffect(() => {
        mounts += 1;
      }, []);
      useEffect(() => {
        if (draft) writeTenantLocalItem(localStorage, "test:private-draft", draft, ownerId);
      }, [draft, ownerId]);
      return (
        <section data-user={ownerId}>
          <output>{draft}</output>
          <button type="button" onClick={() => setDraft("secret-from-a")}>
            Set private draft
          </button>
          <button type="button" onClick={() => void auth.refreshSession()}>
            Refresh session
          </button>
        </section>
      );
    }

    await act(async () =>
      root.render(
        <AuthRoot>
          <TenantApplication />
        </AuthRoot>
      )
    );
    await vi.waitFor(() => expect(container.querySelector("section")?.getAttribute("data-user")).toBe("user-a"));
    await act(async () => container.querySelectorAll("button")[0]?.click());
    expect(container.querySelector("output")?.textContent).toBe("secret-from-a");
    expect(localStorage.getItem("test:private-draft:user-a")).toBe("secret-from-a");

    await act(async () => container.querySelectorAll("button")[1]?.click());
    await vi.waitFor(() => expect(container.querySelector("section")?.getAttribute("data-user")).toBe("user-b"));
    expect(container.querySelector("output")?.textContent).toBe("");
    expect(localStorage.getItem("test:private-draft:user-b")).toBeNull();
    expect(localStorage.getItem("test:private-draft:user-a")).toBe("secret-from-a");
    expect(mounts).toBe(2);
    await act(async () => root.unmount());
  });

  it("refreshes and remounts immediately when another tab changes the shared session", async () => {
    vi.stubGlobal("BroadcastChannel", undefined);
    const sessions = [authSession("user-a"), authSession("user-b")];
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const path = typeof input === "string" ? input : input instanceof URL ? input.pathname : new URL(input.url).pathname;
      if (path === "/api/auth/config") {
        return Promise.resolve(json({ mode: "database", authRequired: true, registrationEnabled: true, tradingRoleAssignmentsEnabled: true }));
      }
      if (path === "/api/auth/me") return Promise.resolve(json(sessions.shift()));
      if (path === "/auth-i18n/en.json") return Promise.resolve(json({ product: "SaltanatbotV2" }));
      return Promise.resolve(json({}));
    });
    vi.stubGlobal("fetch", fetchMock);
    const container = document.createElement("div");
    const root = createRoot(container);
    let mounts = 0;

    function TenantApplication() {
      const auth = useAuth();
      useEffect(() => {
        mounts += 1;
      }, []);
      return <section data-user={auth.user?.id} />;
    }

    await act(async () =>
      root.render(
        <AuthRoot>
          <TenantApplication />
        </AuthRoot>
      )
    );
    await vi.waitFor(() => expect(container.querySelector("section")?.getAttribute("data-user")).toBe("user-a"));

    const change: AuthSessionChange = {
      version: 1,
      id: "external-login",
      source: "another-browser-tab",
      kind: "login",
      at: 100
    };
    await act(async () => {
      window.dispatchEvent(new StorageEvent("storage", { key: AUTH_SESSION_STORAGE_KEY, newValue: JSON.stringify(change) }));
    });

    await vi.waitFor(() => expect(container.querySelector("section")?.getAttribute("data-user")).toBe("user-b"));
    expect(fetchMock.mock.calls.filter(([input]) => String(input).includes("/api/auth/me"))).toHaveLength(2);
    expect(mounts).toBe(2);
    await act(async () => root.unmount());
  });

  it("publishes login and reconciles authoritatively when another tab advances the resolution during login", async () => {
    vi.stubGlobal("BroadcastChannel", undefined);
    const loginResponse = deferred<Response>();
    const staleCrossTabSession = deferred<Response>();
    let meRequests = 0;
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const path = requestPath(input);
      if (path === "/api/auth/config") return Promise.resolve(json(databaseConfig()));
      if (path === "/api/auth/me") {
        meRequests += 1;
        if (meRequests === 1) return Promise.resolve(unauthorized());
        if (meRequests === 2) return staleCrossTabSession.promise;
        if (meRequests === 3) return Promise.resolve(json(authSession("user-a")));
      }
      if (path === "/api/auth/login") return loginResponse.promise;
      if (path === "/auth-i18n/en.json") return Promise.resolve(json({ product: "SaltanatbotV2" }));
      return Promise.resolve(json({}));
    });
    vi.stubGlobal("fetch", fetchMock);
    const container = document.createElement("div");
    const root = createRoot(container);

    await act(async () =>
      root.render(
        <AuthRoot>
          <TenantLabel />
        </AuthRoot>
      )
    );
    await vi.waitFor(() => expect(container.querySelector("#login")).not.toBeNull());
    await changeInput(container.querySelector<HTMLInputElement>("#login")!, "roman");
    await changeInput(container.querySelector<HTMLInputElement>("#current-password")!, "correct horse battery staple");
    await submit(container.querySelector("form.auth-form")!);
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(([input]) => requestPath(input) === "/api/auth/login")).toBe(true));

    await emitExternalAuthChange("login-race");
    await vi.waitFor(() => expect(meRequests).toBe(2));
    await act(async () => loginResponse.resolve(json(authSession("user-a"))));

    await vi.waitFor(() => expect(container.querySelector("section[data-user]")?.getAttribute("data-user")).toBe("user-a"));
    expect(meRequests).toBe(3);
    expect(JSON.parse(localStorage.getItem(AUTH_SESSION_STORAGE_KEY) ?? "null")).toMatchObject({ kind: "login" });

    await act(async () => staleCrossTabSession.resolve(unauthorized()));
    expect(container.querySelector("section[data-user]")?.getAttribute("data-user")).toBe("user-a");
    await act(async () => root.unmount());
  });

  it("publishes logout and ignores an older cross-tab session response after authoritative reconciliation", async () => {
    vi.stubGlobal("BroadcastChannel", undefined);
    const logoutResponse = deferred<Response>();
    const staleCrossTabSession = deferred<Response>();
    let meRequests = 0;
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const path = requestPath(input);
      if (path === "/api/auth/config") return Promise.resolve(json(databaseConfig()));
      if (path === "/api/auth/me") {
        meRequests += 1;
        if (meRequests === 1) return Promise.resolve(json(authSession("user-a")));
        if (meRequests === 2) return staleCrossTabSession.promise;
        if (meRequests === 3) return Promise.resolve(unauthorized());
      }
      if (path === "/api/auth/logout") return logoutResponse.promise;
      if (path === "/auth-i18n/en.json") return Promise.resolve(json({ product: "SaltanatbotV2" }));
      return Promise.resolve(json({}));
    });
    vi.stubGlobal("fetch", fetchMock);
    const container = document.createElement("div");
    const root = createRoot(container);

    await act(async () =>
      root.render(
        <AuthRoot>
          <TenantLabel />
        </AuthRoot>
      )
    );
    await vi.waitFor(() => expect(container.querySelector("section[data-user]")?.getAttribute("data-user")).toBe("user-a"));
    await act(async () => container.querySelector<HTMLButtonElement>(".auth-danger-button")?.click());
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(([input]) => requestPath(input) === "/api/auth/logout")).toBe(true));

    await emitExternalAuthChange("logout-race");
    await vi.waitFor(() => expect(meRequests).toBe(2));
    await act(async () => logoutResponse.resolve(json({})));

    await vi.waitFor(() => expect(container.querySelector("#login")).not.toBeNull());
    expect(meRequests).toBe(3);
    expect(JSON.parse(localStorage.getItem(AUTH_SESSION_STORAGE_KEY) ?? "null")).toMatchObject({ kind: "logout" });

    await act(async () => staleCrossTabSession.resolve(json(authSession("user-a"))));
    expect(container.querySelector("section[data-user]")).toBeNull();
    await act(async () => root.unmount());
  });

  it("publishes password changes and fails closed when the fresh session reconciliation fails", async () => {
    vi.stubGlobal("BroadcastChannel", undefined);
    const passwordResponse = deferred<Response>();
    const staleCrossTabSession = deferred<Response>();
    let meRequests = 0;
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const path = requestPath(input);
      if (path === "/api/auth/config") return Promise.resolve(json(databaseConfig()));
      if (path === "/api/auth/me") {
        meRequests += 1;
        if (meRequests === 1) return Promise.resolve(json(authSession("user-a")));
        if (meRequests === 2) return staleCrossTabSession.promise;
        if (meRequests === 3) return Promise.reject(new TypeError("session reconciliation unavailable"));
      }
      if (path === "/api/auth/change-password") return passwordResponse.promise;
      if (path === "/auth-i18n/en.json") return Promise.resolve(json({ product: "SaltanatbotV2" }));
      return Promise.resolve(json({}));
    });
    vi.stubGlobal("fetch", fetchMock);
    const container = document.createElement("div");
    const root = createRoot(container);

    await act(async () =>
      root.render(
        <AuthRoot>
          <TenantLabel />
        </AuthRoot>
      )
    );
    await vi.waitFor(() => expect(container.querySelector("section[data-user]")?.getAttribute("data-user")).toBe("user-a"));
    await changeInput(container.querySelector<HTMLInputElement>("#password-change-current")!, "old password");
    await changeInput(container.querySelector<HTMLInputElement>("#password-change-new")!, "new secure password");
    await submit(container.querySelector<HTMLInputElement>("#password-change-current")!.closest("form")!);
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(([input]) => requestPath(input) === "/api/auth/change-password")).toBe(true));

    await emitExternalAuthChange("password-race");
    await vi.waitFor(() => expect(meRequests).toBe(2));
    await act(async () => passwordResponse.resolve(json({})));

    await vi.waitFor(() => expect(container.querySelector("#login")).not.toBeNull());
    expect(meRequests).toBe(3);
    expect(JSON.parse(localStorage.getItem(AUTH_SESSION_STORAGE_KEY) ?? "null")).toMatchObject({ kind: "password" });

    await act(async () => staleCrossTabSession.resolve(json(authSession("user-a"))));
    expect(container.querySelector("section[data-user]")).toBeNull();
    await act(async () => root.unmount());
  });
});

function TenantLabel() {
  const auth = useAuth();
  return <section data-user={auth.user?.id} />;
}

function databaseConfig() {
  return { mode: "database", authRequired: true, registrationEnabled: true, tradingRoleAssignmentsEnabled: true };
}

function unauthorized(): Response {
  return new Response(null, { status: 401 });
}

function requestPath(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.pathname : new URL(input.url).pathname;
}

async function emitExternalAuthChange(id: string): Promise<void> {
  const change: AuthSessionChange = { version: 1, id, source: "another-browser-tab", kind: "session", at: 100 };
  await act(async () => {
    window.dispatchEvent(new StorageEvent("storage", { key: AUTH_SESSION_STORAGE_KEY, newValue: JSON.stringify(change) }));
  });
}

async function changeInput(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submit(form: HTMLFormElement): Promise<void> {
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function authSession(id: string) {
  return {
    user: {
      id,
      login: id,
      status: "active",
      appRole: "user",
      tradingRole: "none",
      mustChangePassword: false
    },
    tradingAvailable: false
  };
}

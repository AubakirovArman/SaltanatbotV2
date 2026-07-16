// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authText } from "../src/auth/messages";
import { SessionManager } from "../src/auth/SessionManager";

const CURRENT_SESSION_ID = "00000000-0000-4000-8000-000000000011";

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  document.cookie = "sbv2_csrf=session-test";
});

afterEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("self-service session lifecycle", () => {
  it("offers revoke-others from the authoritative revocable count and hides it after historical sessions remain", async () => {
    const requests: Array<{ path: string; method: string }> = [];
    let gets = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
        const path = String(input);
        requests.push({ path, method: init.method ?? "GET" });
        if (path.startsWith("/api/auth/sessions?")) {
          gets += 1;
          return pageResponse({
            total: 3,
            revocableSessionCount: gets === 1 ? 2 : 1
          });
        }
        return json({
          revokedSessionCount: 1,
          revokedCurrentSession: false
        });
      })
    );
    const changed = vi.fn(async () => {});
    const view = await render(changed);

    const revokeOthers = await waitForButton(view.container, authText("en", "revokeOtherSessions"));
    await click(revokeOthers);
    await click(buttonFor(view.container, authText("en", "confirmAction")));

    await vi.waitFor(() => expect(requests.some((request) => request.path === "/api/auth/sessions/revoke-others" && request.method === "POST")).toBe(true));
    expect(changed).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(gets).toBe(2));
    expect([...view.container.querySelectorAll("button")].some((button) => button.textContent?.trim() === authText("en", "revokeOtherSessions"))).toBe(false);
    expect(view.container.textContent).toContain(authText("en", "noOtherSessions"));
    await act(async () => view.root.unmount());
  });

  it("trusts the server outcome and does not reload when a stale row was actually the current session", async () => {
    let gets = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
        if (String(input).startsWith("/api/auth/sessions?")) {
          gets += 1;
          return pageResponse({
            total: 1,
            revocableSessionCount: 1,
            current: false
          });
        }
        expect(String(input)).toBe(`/api/auth/sessions/${CURRENT_SESSION_ID}/revoke`);
        expect(init.method).toBe("POST");
        return json({
          revokedSessionCount: 1,
          revokedCurrentSession: true
        });
      })
    );
    const changed = vi.fn(async () => {});
    const view = await render(changed);

    await click(await waitForButton(view.container, authText("en", "revokeSession")));
    await click(buttonFor(view.container, authText("en", "confirmAction")));
    await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
    expect(gets).toBe(1);
    await act(async () => view.root.unmount());
  });

  it("reloads when the server says a row marked current was not the request session", async () => {
    let gets = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        if (String(input).startsWith("/api/auth/sessions?")) {
          gets += 1;
          return pageResponse({
            total: 2,
            revocableSessionCount: gets === 1 ? 2 : 1,
            current: true
          });
        }
        return json({
          revokedSessionCount: 1,
          revokedCurrentSession: false
        });
      })
    );
    const changed = vi.fn(async () => {});
    const view = await render(changed);

    await click(await waitForButton(view.container, authText("en", "revokeSession")));
    await click(buttonFor(view.container, authText("en", "confirmAction")));

    await vi.waitFor(() => expect(gets).toBe(2));
    expect(changed).not.toHaveBeenCalled();
    await act(async () => view.root.unmount());
  });
});

async function render(onSessionChanged: () => Promise<void>) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<SessionManager active locale="en" onSessionChanged={onSessionChanged} />);
  });
  return { container, root };
}

async function waitForButton(container: HTMLElement, label: string): Promise<HTMLButtonElement> {
  let button: HTMLButtonElement | undefined;
  await vi.waitFor(() => {
    button = [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === label);
    expect(button).toBeTruthy();
  });
  return button!;
}

function buttonFor(container: ParentNode, label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === label);
  if (!button) throw new Error(`Missing button: ${label}`);
  return button;
}

async function click(button: HTMLButtonElement) {
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
}

function pageResponse({
  current = true,
  revocableSessionCount,
  total
}: {
  current?: boolean;
  revocableSessionCount: number;
  total: number;
}) {
  return json({
    sessions: [
      {
        publicId: CURRENT_SESSION_ID,
        current,
        createdAt: "2026-07-16T10:00:00.000Z",
        lastSeenAt: "2026-07-16T11:00:00.000Z",
        expiresAt: "2026-07-16T22:00:00.000Z"
      }
    ],
    revocableSessionCount,
    page: 1,
    pageSize: 25,
    total,
    totalPages: 1
  });
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
